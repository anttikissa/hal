// Commands the bash tool runs (tools/bash.ts), in the foreground or in
// the background (task v0). Each runs in its own process group, so a
// stop reaches pipelines and background jobs too (tools.killGroup).
//
// A background command's result reaches its session as an advisory
// message from 'bash <id>' once it exits (prompts.submit: into the
// running turn, or a turn of its own when idle, waiting while paused).
// Escape does not stop one; /kill does (stop()), closing its tab does (tabs.close), and so
// does this process exiting (host.init), since no command outlives the
// Hal that ran it. The ids still running are kept in the session's
// metadata (`background`), so the next host tells the session they
// were lost (lost()).

import { spawn } from 'child_process'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { history } from './history.ts'
import { prompts } from './prompts.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { tools } from './tools.ts'
import { busy } from './busy.ts'

export type Run = { done: Promise<string>; stop: (why?: string) => void }
type Job = { sessionId: string; stop: () => void }

// Starts `command` with bash -c in `cwd`, stdout and stderr merged.
// `done` is the status line (`[exit N]`, `[timed out after Ns]`, …)
// then the output, cut past tools.maxChars; it waits for stdout to
// close. `ms`: kill the group after that long.
function exec(command: string, cwd: string, ms?: number, onOutput?: (chunk: string) => void): Run {
	let child = spawn('bash', ['-c', `exec 2>&1\n${command}`], { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
	let kill = () => child.pid !== undefined && tools.killGroup(child.pid)
	let timer = ms === undefined ? undefined : setTimeout(() => end(`timed out after ${ms / 1000}s`), ms)
	// Keep the whole result so the cap can retain it in a blob, up to
	// jobs.keepChars: past that only both ends stay (an endless command
	// must not exhaust the host), the middle counted in a note.
	let half = Math.floor(jobs.keepChars / 2)
	let head = ''
	let tail = ''
	let dropped = 0
	child.stdout!.setEncoding('utf8').on('data', (d: string) => {
		onOutput?.(d)
		if (head.length < half) {
			let take = d.slice(0, half - head.length)
			head += take
			d = d.slice(take.length)
		}
		tail += d
		// Trim only once twice over, so trimming costs O(1) per byte.
		if (tail.length > 2 * half) {
			dropped += tail.length - half
			tail = tail.slice(-half)
		}
	})
	let { promise: done, resolve, reject } = Promise.withResolvers<string>()
	let settled = false
	// A stop or timeout settles at once: a process that left the group
	// (setsid, a daemon) may hold the output pipe open indefinitely.
	let end = (status: string, stop = true) => {
		if (settled) return
		settled = true
		clearTimeout(timer)
		if (stop) {
			kill()
			child.stdout!.destroy()
		}
		if (tail.length > half) {
			dropped += tail.length - half
			tail = tail.slice(-half)
		}
		let gap = dropped ? `\n[${dropped} characters dropped: over ${jobs.keepChars} kept in memory]\n` : ''
		resolve(`[${status}]\n${head}${gap}${tail}`)
	}
	child.on('error', (e) => (clearTimeout(timer), (settled = true), reject(e)))
	child.on('close', (code, sig) => end(sig ? `killed by ${sig}` : `exit ${code}`, false))
	return { done, stop: (why = 'stopped by the user') => end(why) }
}

// Runs `command` for session `sessionId` in the background. One that
// ends within jobs.graceMs (not found, a syntax error) returns its
// result as a foreground one would; otherwise its id.
async function start(sessionId: string, command: string, cwd: string, ms?: number, callId?: string, prepared?: () => Run): Promise<string> {
	let call = callId ? history.readSync(sessionId).findLast((r) => r.type === 'assistant' && r.block.type === 'tool_call' && r.block.id === callId) : undefined
	if (call?.n === undefined) throw new Error('background Bash call has no recorded block id')
	let id = `${sessionId}:${call.n}`
	let run = prepared ? prepared() : jobs.exec(command, cwd, ms)
	let early = await Promise.race([run.done, Bun.sleep(jobs.graceMs).then(() => undefined)])
	if (early !== undefined) return early
	jobs.state.running.set(id, { sessionId, stop: run.stop })
	let meta = sessions.open(sessionId)
	meta.background = [...(meta.background ?? []), id]
	run.done.then(
		(out) => jobs.finish(id, out),
		(e) => jobs.finish(id, `[failed: ${e?.message ?? e}]\n`),
	)
	return `started in background as ${jobs.label(sessionId, id)}`
}

// The displayed id is the recorded tool-call block, not the internal job key.
function label(sessionId: string, id: string): string {
	return id.startsWith(`${sessionId}:`) ? `#t${id.slice(sessionId.length + 1)}` : id
}

// Takes `id` off the session's list of running commands.
function forget(sessionId: string, id: string): void {
	let meta = sessions.open(sessionId)
	let left = (meta.background ?? []).filter((b) => b !== id)
	if (left.length) meta.background = left
	else delete meta.background
}

// A background command exited: its session hears how, unless it was
// stopped by closing the session.
function finish(id: string, out: string): void {
	let job = jobs.state.running.get(id)
	if (!job) return
	jobs.state.running.delete(id)
	jobs.forget(job.sessionId, id)
	jobs.tell(job.sessionId, id, tools.cap(out, job.sessionId, tools.bashMaxChars, tools.bashMaxLines))
}

// Sends `text` to the session as an advisory message from 'bash <id>'.
function tell(sessionId: string, id: string, text: string): void {
	let deliver = () => {
		let refused = prompts.submit(sessionId, text, undefined, 'steer', { from: sessionId, label: `bash ${jobs.label(sessionId, id)}`, advisory: true })
		if (refused) diag.log(`bash ${id} to ${sessionId}: ${refused}`)
	}
	let ready = host.ready(sessionId)
	if (!ready) return deliver()
	ready.then(deliver, (e) => diag.log(`bash ${id} to ${sessionId}: ${e?.message ?? e}`))
}

// The session's background commands still running here.
function running(sessionId: string): string[] {
	return [...jobs.state.running].filter(([, j]) => j.sessionId === sessionId).map(([id]) => id)
}

// Stops the session's background commands without telling it (its tab
// closed).
function kill(sessionId: string): void {
	for (let id of jobs.running(sessionId)) {
		jobs.state.running.get(id)!.stop()
		jobs.state.running.delete(id)
		jobs.forget(sessionId, id)
	}
}

// Stops the session's background command `ref` (#t123, #123 or 123;
// none: its only one), as /kill does. Its session hears it was stopped
// by the user, as for any exit. Returns a refusal, or what it stopped.
function stop(sessionId: string, ref: string): { refused?: string; stopped?: string } {
	let ids = jobs.running(sessionId)
	let n = ref.trim().match(/^#?t?(\d+)$/)?.[1]
	let list = ids.map((id) => jobs.label(sessionId, id)).join(', ')
	if (!ref.trim()) {
		if (ids.length !== 1) return { refused: ids.length ? `several background jobs run (${list}); name one` : 'no background jobs running' }
	} else if (n === undefined) return { refused: `not a job number: ${ref.trim()}` }
	let id = n === undefined ? ids[0]! : `${sessionId}:${n}`
	let job = jobs.state.running.get(id)
	if (!job || job.sessionId !== sessionId) return { refused: `#t${n} is not running${ids.length ? ` (running: ${list})` : ''}` }
	job.stop()
	return { stopped: jobs.label(sessionId, id) }
}

// This process exits: stops every background command, leaving the
// metadata for the next host to report them lost. Synchronous.
function killAll(): void {
	for (let job of jobs.state.running.values()) job.stop()
	jobs.state.running.clear()
}

// A new host: every open or busy session whose metadata names
// background commands that no longer run here hears they were lost.
async function lost(): Promise<void> {
	for (let id of new Set([...tabs.file().open, ...busy.list()])) {
		try {
			let listed = sessions.open(id).background?.filter((b) => !jobs.state.running.has(b))
			if (!listed?.length) continue
			await (host.ready(id) ?? Promise.resolve())
			for (let b of listed) {
				jobs.forget(id, b)
				jobs.tell(id, b, `bash ${jobs.label(id, b)} was lost when Hal restarted`)
			}
		} catch (e: any) {
			diag.log(`lost jobs ${id}: ${e?.message ?? e}`)
		}
	}
}

// Why a tool's signal fired. A message sent mid-turn (task 8p) aborts
// with `steered`: the model must read that the user spoke, never that
// the user wanted the work stopped. `byMessage` marks such a result
// (turns.ts: not a failure, task ker).
const steered = 'steered'
const byMessage = 'by a new user message, which follows; read it, then carry on'
function why(signal: AbortSignal, stopped = 'canceled'): string {
	return `${stopped} ${signal.reason === steered ? byMessage : 'by the user'}`
}

export const jobs = {
	steered,
	byMessage,
	why,
	// `running`: background commands of this process, by id.
	state: { running: new Map<string, Job>() },
	// How long a background call waits for a command that fails at once.
	graceMs: 100,
	// Background jobs must not run unseen indefinitely; callers may override it.
	backgroundMs: 600_000,
	// The most output one command keeps in memory (both ends past it).
	keepChars: 32_000_000,
	exec,
	start,
	label,
	forget,
	finish,
	tell,
	running,
	kill,
	stop,
	killAll,
	lost,
}
