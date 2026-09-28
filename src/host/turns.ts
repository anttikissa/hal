// Running turns: the provider rounds from a prompt to the model's
// answer, their tools and questions, pausing, and recovering turns left
// unfinished on disk. A turn with no end record is unfinished; whichever
// process becomes host continues it (recover).

import { blocks, type DoneEvent, type ErrorEvent, type ImageBlock, type Sender, type StreamEvent, type ToolCallBlock, type ToolResultBlock, type Usage } from '../common/blocks.ts'
import { forms, type Answers, type Form } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { settings } from '../common/settings.ts'
import type { StateEvent } from '../common/states.ts'
import { approval } from './approval.ts'
import { auth } from './auth.ts'
import { blobs } from './blobs.ts'
import { clock } from './clock.ts'
import { compact } from './compact.ts'
import { turnRecovery } from './turn-recovery.ts'
import { tool as askTool } from './tools/ask.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { models } from './models.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { sessions } from './sessions.ts'
import { synthetic } from './synthetic.ts'
import { systemPrompt } from './system-prompt.ts'
import { tools } from './tools.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { stats } from './stats.ts'
import { status } from './status.ts'
import { subagents } from './subagents.ts'
import { toolOutput } from './tool-output.ts'
// A running turn settles when runTurn returns (task hp).
type Running = { provider: string; model?: string; effort?: string; controller: AbortController; done?: Promise<void> }
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
	let { n } = history.append(id, record)
	host.broadcast(id, { type: 'question', sessionId: id, id: question, form, n })
	status.transition(id, { type: 'block', reason: 'question' })
}

// Runs a turn whose prompt or `continue` record is in history.
// `answers`: the fresh answer to its question, secrets included;
// `images`: the prompt's image blocks, for followers to show; `record`:
// the prompt's, whose number, command id and sender (of its first text)
// they are told.
function start(id: string, prompt?: string, answers?: Answers, images?: ImageBlock[], record?: { n?: number; command?: string; sender?: Sender; ts?: string }): void {
	let model = sessions.open(id).model
	let running: Running = { provider: blocks.parseModelId(model)?.provider ?? model, model, controller: new AbortController() }
	let effort = models.effort(model)
	if (effort !== undefined) running.effort = effort
	turns.state.running.set(id, running)
	let event: Event & { type: 'turn-start' } = { type: 'turn-start', sessionId: id, provider: running.provider, model }
	if (effort !== undefined) event.effort = effort
	if (prompt !== undefined && record?.ts !== undefined) event.ts = record.ts
	if (prompt !== undefined) event.prompt = prompt
	if (images?.length) event.images = images
	if (prompt !== undefined && record?.sender?.from !== undefined) event.sender = record.sender
	if (prompt !== undefined && record?.n !== undefined) event.n = record.n
	if (prompt !== undefined && record?.command !== undefined) event.command = record.command
	host.broadcast(id, event)
	running.done = turns.runTurn(id, model, running, answers).catch((e) => diag.log(`turn ${id}: ${e?.message ?? e}`))
}

// Pauses the session's turn: one running here stops and runTurn records
// it paused; one not running here (unfinished on disk) is paused on disk.
// A command's open question is dismissed instead: nothing ran.
function stop(id: string, reason?: string): string | undefined {
	let records = history.readSync(id)
	let open = forms.open(records)
	if (open?.call && records.some((r) => r.type === 'assistant' && r.block.type === 'tool_call' && r.block.id === open.call && r.block.name === 'ask')) {
		let refused = status.transition(id, { type: 'answer' })
		if (refused) return refused
		history.append(id, { type: 'answer', question: open.id, answers: {}, cancelled: true })
		host.broadcast(id, { type: 'answer', sessionId: id, question: open.id, answers: {}, cancelled: true })
		turns.start(id)
		return
	}
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
	let recorded = history.append(id, end) as HistoryRecord & { type: 'turn_end' }
	let ended: Event = { type: 'turn-end', sessionId: id, status: 'paused', n: recorded.n, stats: stats.ended(id, recorded) }
	if (Object.keys(end.usage).length) ended.usage = end.usage
	host.broadcast(id, ended)
	subagents.report(id)
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
			let system = systemPrompt.build({ cwd: sessions.open(id).cwd, model, now: clock.now(), sessionId: id })
			return yield* turns.stream(model, { system, messages: await history.messages(id), tools: tools.defs(), image: (blob) => blobs.base64(id, blob), sessionId: id }, signal)
		}
		let reply = scripted(await history.read(id), answers, id)
		answers = undefined
		asking = reply.ask
		if (reply.say) yield { type: 'text', text: reply.say }
		yield { type: 'done', reason: 'end' }
	}
	let last: DoneEvent | ErrorEvent | undefined
	let failure: string | undefined
	// Failed rounds in a row, for the backoff.
	let failures = 0
	// Compacted once already for a prompt too long (compact.retry).
	let shrunk = false
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
				for await (let event of history.record(id, running.provider, stream(), running)) {
					blocks.apply(round, event)
					if (event.type === 'done' || event.type === 'error') {
						last = event
						break
					}
					if (signal.aborted) break
					status.transition(id, { type: 'stream' })
					let n = history.streaming(id)
					let ts = history.started(id)
					host.broadcast(id, { type: 'stream', sessionId: id, event, ...(n !== undefined && { n }), ...(ts !== undefined && { ts }) })
				}
				if (last?.type === 'error' && !signal.aborted && compact.retry(id, last, shrunk)) {
					shrunk = true
					continue
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
				// A paused server-side answer (web search) goes on from itself.
				if (!calls.length) {
					if (last.reason === 'pause' && !signal.aborted) continue
					if (signal.aborted || !status.inboxOf(id).some((m) => !m.queue)) break
					continue
				}
			}
			if (cancelled()) break
			for (let call of calls) {
				if (call.name === 'ask' && !askTool.answered(history.readSync(id), call)) {
					// Bad model input is a tool error, not a broken turn.
					let form: Form
					try { form = askTool.form(call.input) } catch { continue }
					return turns.ask(id, form, call.id)
				}
				let form = decided.has(call.id) ? undefined : approval.form(call)
				if (form) return turns.ask(id, form, call.id)
			}
			let cwd = sessions.open(id).cwd
			status.transition(id, { type: 'tools' })
			let results: ToolResultBlock[] = []
			let ending = false
			let ctx = { cwd, signal, sessionId: id, endTurn: () => (ending = true) }
			for (let call of calls) {
				if (call.name !== 'ask' && decided.get(call.id) === false) { results.push(approval.declined(call)); continue }
				let stream = call.name === 'bash' && call.input.background !== true ? toolOutput.start(id, call.id) : undefined
				try { results.push(await tools.run(call, stream ? { ...ctx, onOutput: stream.onOutput } : ctx)) }
				finally { stream?.stop() }
			}
			if (turns.state.running.get(id) !== running) return
			let n = history.results(id, results)?.n
			host.broadcast(id, n === undefined ? { type: 'tool-results', sessionId: id, results } : { type: 'tool-results', sessionId: id, results, n })
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
		if (recorded.n !== undefined) end.n = recorded.n
		if (Object.keys(recorded.usage).length) end.usage = recorded.usage
		if (recorded.error !== undefined) end.error = recorded.error
		end.stats = stats.ended(id, recorded)
	}
	host.broadcast(id, end)
	// Paused already, unless something other than the user aborted it.
	if (end.status === 'paused') status.transition(id, capped === undefined ? { type: 'pause' } : { type: 'pause', reason: capped })
	else status.transition(id, end.status === 'error' ? { type: 'end', error: end.error ?? 'turn failed' } : { type: 'end' })
	subagents.report(id)
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
	recover: () => turnRecovery.recover(),
	leftWork: (id: string) => turnRecovery.leftWork(id),
	runTurn,
	parkedUsage,
	stopped,
	waitOut,
	backoffMs,
}
