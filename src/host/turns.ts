// Running turns: the provider rounds from a prompt to the model's
// answer, their tools and questions, pausing, and recovering turns left
// unfinished on disk. A turn with no end record is unfinished; whichever
// process becomes host continues it (recover).

import { blocks, type DoneEvent, type ErrorEvent, type ImageBlock, type Sender, type StreamEvent, type ToolCallBlock, type ToolResultBlock, type Usage } from '../common/blocks.ts'
import { forms, type Answers, type Form } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { settings } from '../common/settings.ts'
import { states, type StateEvent } from '../common/states.ts'
import { existsSync } from 'fs'
import { approval } from './approval.ts'
import { auth } from './auth.ts'
import { blobs } from './blobs.ts'
import { busy } from './busy.ts'
import { clock } from './clock.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { sessions } from './sessions.ts'
import { synthetic } from './synthetic.ts'
import { systemPrompt } from './system-prompt.ts'
import { tools } from './tools.ts'
import { host } from './host.ts'
import { pages } from './pages.ts'
import { tabs } from './tabs.ts'
import { prompts } from './prompts.ts'
import { status } from './status.ts'
import { subagents } from './subagents.ts'

// `done`: settles when runTurn has returned.
type Running = { provider: string; controller: AbortController; done?: Promise<void> }

// Asks the open turn's human a durable question: in history first,
// then shown; the turn stops running here and waits, blocked, for the
// first answer (reply), which runs it again. Nothing waits in memory:
// the question keeps the turn's usage so far. `call`: the tool call it
// asks approval for.
function ask(id: string, form: Form, call?: string): void {
	let problem = forms.invalid(form)
	if (problem) throw new Error(`bad question: ${problem}`)
	let question = crypto.randomUUID().slice(0, 8)
	let usage = history.park(id)
	turns.state.running.delete(id)
	let record: Omit<HistoryRecord & { type: 'question' }, 'ts'> = { type: 'question', id: question, form }
	if (call !== undefined) record.call = call
	if (Object.keys(usage).length) record.usage = usage
	history.append(id, record)
	host.broadcast(id, { type: 'question', sessionId: id, id: question, form })
	status.transition(id, { type: 'block', reason: 'question' })
}

// Runs a turn whose prompt or `continue` record is in history.
// `answers`: the fresh answer to its question, secrets included;
// `images`: the prompt's image blocks, for followers to show; `sender`:
// who sent the prompt, if not the human.
function start(id: string, prompt?: string, answers?: Answers, images?: ImageBlock[], sender?: Sender): void {
	let model = sessions.open(id).model
	let running: Running = { provider: blocks.parseModelId(model)?.provider ?? model, controller: new AbortController() }
	turns.state.running.set(id, running)
	let event: Event = { type: 'turn-start', sessionId: id, provider: running.provider }
	if (prompt !== undefined) event.prompt = prompt
	if (images?.length) event.images = images
	if (sender?.from !== undefined) event.sender = sender
	host.broadcast(id, event)
	running.done = turns.runTurn(id, model, running, answers).catch((e) => diag.log(`turn ${id}: ${e?.message ?? e}`))
}

// Pauses the session's turn: one running here stops and runTurn records
// it paused; one not running here (unfinished on disk) is paused on disk.
// A command's open question is dismissed instead: nothing ran.
function stop(id: string, reason?: string): string | undefined {
	let open = forms.open(history.readSync(id))
	if (open?.from) {
		let before = status.stateOf(id)
		history.append(id, { type: 'answer', question: open.id, answers: {}, cancelled: true })
		host.broadcast(id, { type: 'answer', sessionId: id, question: open.id, answers: {}, cancelled: true })
		status.settle(id, before)
		return void prompts.drain(id)
	}
	let event: StateEvent = { type: 'pause' }
	if (reason !== undefined) event.reason = reason
	let refused = status.transition(id, event)
	if (refused) return refused
	let running = turns.state.running.get(id)
	if (running) return void running.controller.abort()
	// A turn parked at a question has its usage so far there.
	let end: Omit<HistoryRecord & { type: 'turn_end' }, 'ts'> = { type: 'turn_end', status: 'paused', usage: forms.open(history.readSync(id))?.usage ?? {} }
	if (reason !== undefined) end.pauseReason = reason
	history.append(id, end)
	let ended: Event = { type: 'turn-end', sessionId: id, status: 'paused' }
	if (Object.keys(end.usage).length) ended.usage = end.usage
	host.broadcast(id, ended)
}

// Continues every unfinished turn on disk (a new host after a restart or
// a host that went away). A turn that keeps bringing hosts down would
// loop forever, so after states.maxRecoveries() continuations without
// progress it is paused with a reason instead. An idle session whose
// inbox still holds queued messages (the host died between a turn end
// and the next queued prompt) runs the oldest, as prompts.next would have.
//
// It costs what the open tabs and busy sessions (busy.ts) cost, never
// what is on disk: only their marks (pages.ts) are read, and a whole
// history only for a session with work left.
async function recover(): Promise<void> {
	for (let id of new Set([...tabs.file().open, ...busy.list()])) {
		if (turns.state.running.has(id)) continue
		if (!existsSync(history.file(id))) {
			busy.drop(id)
			continue
		}
		if (!turns.leftWork(id)) {
			busy.drop(id)
			continue
		}
		try {
			await (host.ready(id) ?? Promise.resolve())
		} catch (e: any) {
			diag.log(`recover ${id}: ${e?.message ?? e}`)
			continue
		}
		let records = history.readSync(id)
		if (turns.state.running.has(id)) continue
		let state = status.stateOf(id, records)
		if (state.type === 'idle') {
			prompts.next(id)
			continue
		}
		if (state.type !== 'running') continue
		let n = states.recoveries(records)
		if (n >= states.maxRecoveries()) {
			turns.stop(id, `continued ${n} times without progress; it may be what stops the host`)
			continue
		}
		history.append(id, { type: 'continue' })
		turns.start(id)
	}
}

// Whether a session may have a turn to continue or a queued message to
// run, from its marks alone: its last turn record is no end, or a queued
// message waits after a completed turn (or before any turn).
function leftWork(id: string): boolean {
	let m = pages.marks(id)
	let path = history.file(id)
	let last = m.turn === undefined ? undefined : pages.lineAt(path, m.turn).record
	if (last && last.type !== 'turn_end') return true
	if (last && last.status !== 'completed') return false
	return Object.values(m.inbox).flat().some((at) => {
		let r = pages.lineAt(path, at).record
		return r.type === 'inbox' && r.queue === true
	})
}

// Runs one turn and always ends it. A turn is every provider round from
// the prompt to the model's answer: while a round ends asking for tools,
// the host runs them, records their results and starts the next round.
// Blocks and results are in history before followers hear of them, and
// there is one turn end, with the usage of all rounds. Provider input is
// read from history inside the recorded stream, so a failure to build
// it ends the turn too.
//
// A tool call is recorded before it runs and its result after, so a
// host that dies in between leaves an unanswered call: the next host
// continues the turn, telling the model it may or may not have run, and
// never runs it again (replay.ts).
//
// A round that fails in a way the host can fix (error.failure,
// provider.ts) is tried again within the turn: retrying at a time, or
// blocked on a login; only the user's Escape stops that.
//
// A synthetic model (synthetic.ts) runs here instead of a provider and
// may end its round by asking a question, which parks the turn (ask).
// So may a dangerous tool call (approval.ts): each one asks, one at a
// time, before any of the round's calls runs; once all are answered
// the turn, run again, finds the calls held (approval.held) and runs
// them, or gives the declined ones an error result, before its next
// round. A parked turn's usage so far is in its question and carried on.
//
// A turn never spirals: after settings.maxRounds() finished rounds it
// pauses with a reason, and continuing gives it as many again. A round
// cut off at max_tokens or refused runs none of its calls and ends the
// turn in error (stopped).
async function runTurn(id: string, model: string, running: Running, answers?: Answers): Promise<void> {
	let { signal } = running.controller
	let records = history.readSync(id)
	history.carry(id, running.provider, turns.parkedUsage(records))
	let held = approval.held(records)
	let asking: Form | undefined
	async function* stream(): AsyncGenerator<StreamEvent> {
		let scripted = synthetic.find(model)
		if (!scripted) {
			let system = systemPrompt.build({ cwd: sessions.open(id).cwd, model, now: clock.now() })
			return yield* turns.stream(model, { system, messages: await history.messages(id), tools: tools.defs(), image: (blob) => blobs.base64(id, blob) }, signal)
		}
		let reply = scripted(await history.read(id), answers)
		answers = undefined
		asking = reply.ask
		if (reply.say) yield { type: 'text', text: reply.say }
		yield { type: 'done', reason: 'end' }
	}
	let last: DoneEvent | ErrorEvent | undefined
	let failure: string | undefined
	// Failed rounds in a row, for the backoff.
	let failures = 0
	// Finished rounds, and why Hal paused the turn if it did.
	let rounds = 0
	let capped: string | undefined
	try {
		while (true) {
			// The turn wanted to go on: a pause now stops it as paused.
			let cancelled = () => signal.aborted && ((last = undefined), true)
			let calls: ToolCallBlock[]
			let decided = held?.decided ?? new Map<string, boolean>()
			if (held) {
				calls = held.calls
				held = undefined
			} else {
				if (rounds >= settings.maxRounds()) {
					capped = `it ran ${rounds} rounds, the most one turn may (maxRounds)`
					last = undefined
					break
				}
				let round = blocks.newTurn(running.provider)
				last = undefined
				prompts.steer(id)
				status.transition(id, { type: 'request' })
				for await (let event of history.record(id, running.provider, stream())) {
					blocks.apply(round, event)
					if (event.type === 'done' || event.type === 'error') {
						last = event
						break
					}
					if (signal.aborted) break
					status.transition(id, { type: 'stream' })
					host.broadcast(id, { type: 'stream', sessionId: id, event })
				}
				if (last?.type === 'error' && last.failure && !last.cancelled && !signal.aborted) {
					await turns.waitOut(id, last, failures++, signal)
					if (turns.state.running.get(id) !== running) return
					if (signal.aborted) {
						last = undefined
						break
					}
					continue
				}
				if (last?.type === 'done') {
					failures = 0
					rounds++
					last = turns.stopped(last)
				}
				if (asking && last?.type === 'done' && !signal.aborted) return turns.ask(id, asking)
				calls = round.blocks.filter((b) => b.type === 'tool_call')
				if (last?.type !== 'done') break
				// A finished answer with steering waiting: the model hears it.
				if (!calls.length) {
					if (signal.aborted || !status.inboxOf(id).some((m) => !m.queue)) break
					continue
				}
			}
			if (cancelled()) break
			for (let call of calls) {
				let form = decided.has(call.id) ? undefined : approval.form(call)
				if (form) return turns.ask(id, form, call.id)
			}
			let cwd = sessions.open(id).cwd
			status.transition(id, { type: 'tools' })
			let results: ToolResultBlock[] = []
			let ending = false
			let ctx = { cwd, signal, sessionId: id, endTurn: () => (ending = true) }
			for (let call of calls) results.push(decided.get(call.id) === false ? approval.declined(call) : await tools.run(call, ctx))
			if (turns.state.running.get(id) !== running) return
			history.results(id, results)
			host.broadcast(id, { type: 'tool-results', sessionId: id, results })
			if (cancelled()) break
			// A wait: the turn ends, done, unless steering waits to be read.
			if (ending && !status.inboxOf(id).some((m) => !m.queue)) {
				last = { type: 'done', reason: 'tool_use' }
				break
			}
		}
	} catch (e: any) {
		failure = String(e?.message ?? e)
	}
	// A reset host has forgotten this turn; don't write into its successor.
	if (turns.state.running.get(id) !== running) return
	turns.state.running.delete(id)
	let recorded: ReturnType<typeof history.readSync>[number] | undefined
	try {
		history.end(id, failure !== undefined ? { type: 'error', message: failure } : last, capped)
		recorded = history.readSync(id).at(-1)
	} catch (e: any) {
		failure ??= String(e?.message ?? e)
	}
	let end: Event & { type: 'turn-end' } = { type: 'turn-end', sessionId: id, status: 'error', error: failure ?? 'turn end was not recorded' }
	if (recorded?.type === 'turn_end') {
		end = { type: 'turn-end', sessionId: id, status: recorded.status }
		if (Object.keys(recorded.usage).length) end.usage = recorded.usage
		if (recorded.error !== undefined) end.error = recorded.error
	}
	host.broadcast(id, end)
	// Paused already, unless something other than the user aborted it.
	if (end.status === 'paused') status.transition(id, capped === undefined ? { type: 'pause' } : { type: 'pause', reason: capped })
	else status.transition(id, end.status === 'error' ? { type: 'end', error: end.error ?? 'turn failed' } : { type: 'end' })
	if (end.status === 'completed') {
		prompts.next(id)
		subagents.finished(id)
	}
}

// A round's end as the turn takes it: one cut off (max_tokens, or the
// context window) or refused is an error saying why, so none of its
// tool calls runs; any other end stands.
function stopped(done: DoneEvent): DoneEvent | ErrorEvent {
	if (done.reason === 'max_tokens') return { type: 'error', message: 'Response stopped: max_tokens' }
	if (done.reason === 'refusal') return { type: 'error', message: `Refused: ${done.explanation ?? 'the provider gave no explanation'}` }
	return done
}

// The usage an unfinished turn had when it was last parked at a
// question, to go on from; none if it never was.
function parkedUsage(records: HistoryRecord[]): Usage {
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'turn_end') break
		if (r.type === 'question' && r.usage) return r.usage
	}
	return {}
}

// Waits out a failed round (tasks/j1/states.md, Failures) and shows
// why: retrying at a time (temporary: at once, then backing off; rate
// limited: when the provider said, or at once when another account can
// take over), or blocked until the credentials file changes (a broken
// login). Ends early on Escape (`signal`); a wake retries at once.
async function waitOut(id: string, error: ErrorEvent, failures: number, signal: AbortSignal): Promise<void> {
	// Output cut off mid-answer: the model hears it was interrupted.
	if (history.readSync(id).at(-1)?.type === 'assistant') history.append(id, { type: 'continue' })
	if (error.failure === 'auth' && error.retryAt === undefined) {
		status.transition(id, { type: 'block', reason: `log in: ${error.message}` })
		await auth.changed(signal)
		return
	}
	let at = error.retryAt ?? clock.now() + turns.backoffMs(failures)
	status.transition(id, { type: 'retry', at: new Date(at).toISOString(), reason: error.message })
	await clock.until(at, signal)
}

// The wait before the next try after `failures` failed rounds in a
// row: none at first, then doubling up to half a minute.
function backoffMs(failures: number): number {
	return failures === 0 ? 0 : Math.min(1000 * 2 ** (failures - 1), 30_000)
}

export const turns = {
	state: {
		running: new Map<string, Running>(),
	},
	stream: (model: string, input: Omit<ProviderRequest, 'model'>, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
		provider.stream(model, input, signal),
	ask,
	start,
	stop,
	recover,
	leftWork,
	runTurn,
	parkedUsage,
	stopped,
	waitOut,
	backoffMs,
}
