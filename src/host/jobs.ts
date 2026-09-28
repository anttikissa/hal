// Commands the bash tool runs (tools/bash.ts), in the foreground or in
// the background (task v0). Each runs in its own process group, so a
// stop reaches pipelines and background jobs too (tools.killGroup).
//
// A background command's result reaches its session as an advisory
// message from 'bash <id>' once it exits (prompts.submit: into the
// running turn, or a turn of its own when idle, waiting while paused).
// Escape does not stop one; closing its tab does (tabs.close), and so
// does this process exiting (host.init), since no command outlives the
// Hal that ran it. The ids still running are kept in the session's
// metadata (`background`), so the next host tells the session they
// were lost (lost()).

import { spawn } from 'child_process'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { tools } from './tools.ts'
import { busy } from './busy.ts'

export type Run = { done: Promise<string>; stop: () => void }
type Job = { sessionId: string; stop: () => void }

// Starts `command` with bash -c in `cwd`, stdout and stderr merged.
// `done` is the status line (`[exit N]`, `[timed out after Ns]`, …)
// then the output, cut past tools.maxChars(); it waits for stdout to
// close. `ms`: kill the group after that long.
function exec(command: string, cwd: string, ms?: number, onOutput?: (chunk: string) => void): Run {
	let child = spawn('bash', ['-c', `exec 2>&1\n${command}`], { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
	let kill = () => child.pid !== undefined && tools.killGroup(child.pid)
	let stopped = false
	let timedOut = false
	let timer = ms === undefined ? undefined : setTimeout(() => ((timedOut = true), kill()), ms)
	// Keep the whole result so the cap can retain it in a blob, up to
	// jobs.keepChars(): past that only both ends stay (an endless command
	// must not exhaust the host), the middle counted in a note.
	let half = Math.floor(jobs.keepChars() / 2)
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
	let done = new Promise<string>((resolve, reject) => {
		child.on('error', (e) => (clearTimeout(timer), reject(e)))
		child.on('close', (code, sig) => {
			clearTimeout(timer)
			let status = stopped ? 'stopped by the user' : timedOut ? `timed out after ${ms! / 1000}s` : sig ? `killed by ${sig}` : `exit ${code}`
			if (tail.length > half) {
				dropped += tail.length - half
				tail = tail.slice(-half)
			}
			let gap = dropped ? `\n[${dropped} characters dropped: over ${jobs.keepChars()} kept in memory]\n` : ''
			resolve(`[${status}]\n${head}${gap}${tail}`)
		})
	})
	return { done, stop: () => ((stopped = true), kill()) }
}

// Runs `command` for session `sessionId` in the background. One that
// ends within jobs.graceMs() (not found, a syntax error) returns its
// result as a foreground one would; otherwise its id.
async function start(sessionId: string, command: string, cwd: string, ms?: number): Promise<string> {
	let run = jobs.exec(command, cwd, ms)
	let early = await Promise.race([run.done, Bun.sleep(jobs.graceMs()).then(() => undefined)])
	if (early !== undefined) return early
	let id = jobs.newId()
	jobs.state.running.set(id, { sessionId, stop: run.stop })
	let meta = sessions.open(sessionId)
	meta.background = [...(meta.background ?? []), id]
	run.done.then(
		(out) => jobs.finish(id, out),
		(e) => jobs.finish(id, `[failed: ${e?.message ?? e}]\n`),
	)
	return `started in background as ${id}`
}

// A short id unique among this home's running commands.
function newId(): string {
	return `b${Buffer.from(crypto.getRandomValues(new Uint8Array(3))).toString('hex')}`
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
	jobs.tell(job.sessionId, id, tools.cap(out, job.sessionId))
}

// Sends `text` to the session as an advisory message from 'bash <id>'.
function tell(sessionId: string, id: string, text: string): void {
	let deliver = () => {
		let refused = prompts.submit(sessionId, text, undefined, false, { from: sessionId, label: `bash ${id}`, advisory: true })
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
				jobs.tell(id, b, `bash ${b} was lost when Hal restarted`)
			}
		} catch (e: any) {
			diag.log(`lost jobs ${id}: ${e?.message ?? e}`)
		}
	}
}

export const jobs = {
	// `running`: background commands of this process, by id.
	state: { running: new Map<string, Job>() },
	// How long a background call waits for a command that fails at once.
	graceMs: () => 100,
	// The most output one command keeps in memory (both ends past it).
	keepChars: () => 32_000_000,
	exec,
	start,
	newId,
	forget,
	finish,
	tell,
	running,
	kill,
	killAll,
	lost,
}
