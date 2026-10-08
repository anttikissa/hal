// Running turns: the provider rounds from a prompt to the model's
// answer, their tools and questions, pausing, and recovering turns left
// unfinished on disk. A turn with no end record is unfinished; whichever
// process becomes host continues it (recover).
// Tasks: yq, xz, svt, 6eq, rqq, 81y.

import { blocks, type DoneEvent, type ErrorEvent, type ImageBlock, type Sender, type StreamEvent, type ToolCallBlock, type ToolResultBlock } from '../common/blocks.ts'
import { forms, type Answers, type Form } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { settings } from '../common/settings.ts'
import type { StateEvent } from '../common/states.ts'
import { approval } from './approval.ts'
import { blobs } from './blobs.ts'
import { clock } from './clock.ts'
import { contextTransitions } from './context-transitions.ts'
import { compact } from './compact.ts'
import { turnRecovery } from './turn-recovery.ts'
import { turnPolicy } from './turn-policy.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { models } from './models.ts'
import { neighbors } from './neighbors.ts'
import { notify } from './notify.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { sessions } from './sessions.ts'
import { synthetic, type Reply } from './synthetic.ts'
import { systemPrompt } from './system-prompt.ts'
import { tools } from './tools.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { jobs } from './jobs.ts'
import { slash } from './slash.ts'
import { stats } from './stats.ts'
import { status } from './status.ts'
import { subagents } from './subagents.ts'
import { autoclose } from './autoclose.ts'
import { toolOutput } from './tool-output.ts'
import { actions } from './actions.ts'
import { edit } from './tools/edit.ts'
// A running turn settles when runTurn returns (task hp).
// `rewait`: ends the current wait out of a failed round (a model switch).
// `unsafe`: calls flagged unsafeToStop that run (by id: input, since
// when), so a steer waits for them all to end (`steered`, prompts.submit)
// and a restart asks first (commands/restart.ts; task ker).
type Running = { provider: string; model?: string; effort?: string; controller: AbortController; done?: Promise<void>; rewait?: AbortController; unsafe?: Map<string, { input: Record<string, unknown>; at: number }>; steered?: true }
// Asks the open turn's human a durable question: in history first,
// then shown; the turn stops running here and waits, blocked, for the
// first answer (reply), which runs it again. Nothing waits in memory:
// the question keeps the turn's usage so far. `call`: the tool call it
// asks approval for.
function ask(id: string, form: Form, call?: string): void {
	let problem = forms.invalid(form)
	if (problem) throw new Error(`bad question: ${problem}`)
	// A command's open question gives way: one question at a time.
	let open = forms.open(history.readSync(id))
	if (open?.from) slash.dismiss(id, open.id)
	let question = crypto.randomUUID().slice(0, 8)
	let usage = history.park(id)
	turns.state.running.delete(id)
	let record: Omit<HistoryRecord & { type: 'question' }, 'ts'> = { type: 'question', id: question, form }
	if (call !== undefined) record.call = call
	if (Object.keys(usage).length) record.usage = usage
	let { n, ts } = history.append(id, record)
	host.broadcast(id, { type: 'question', sessionId: id, id: question, form, n, ts })
	status.transition(id, { type: 'block', reason: 'question' })
}

// Runs a turn whose prompt or `continue` record is in history.
// `answers`: the fresh answer to its question, secrets included;
// `images`: the prompt's image blocks, for followers to show; `record`:
// the prompt's, whose number, command id and sender (of its first text)
// they are told.
function start(id: string, prompt?: string, answers?: Answers, images?: ImageBlock[], record?: { inbox?: string[]; n?: number; command?: string; sender?: Sender; ts?: string }): void {
	let model = sessions.open(id).model
	let running: Running = { provider: '', controller: new AbortController() }
	let effort = target(running, model, sessions.open(id).effort)
	turns.state.running.set(id, running)
	let event: Event & { type: 'turn-start' } = { type: 'turn-start', sessionId: id, provider: running.provider, model }
	if (effort !== undefined) event.effort = effort
	if (prompt !== undefined && record?.ts !== undefined) event.ts = record.ts
	if (prompt !== undefined) event.prompt = prompt
	if (images?.length) event.images = images
	if (prompt !== undefined && record?.sender && Object.keys(record.sender).length) event.sender = record.sender
	if (prompt !== undefined && record?.n !== undefined) event.n = record.n
	if (prompt !== undefined && record?.command !== undefined) event.command = record.command
	if (record?.inbox?.length) event.inbox = record.inbox
	host.broadcast(id, event)
	running.done = turns.runTurn(id, model, running, answers).catch((e) => diag.log(`turn ${id}: ${e?.message ?? e}`))
}

// Pauses the session's turn: one running here stops and runTurn records
// it paused; one not running here (unfinished on disk) is paused on disk.
// A command's open question is dismissed instead: nothing ran.
function stop(id: string, reason?: string, closing = false): string | undefined {
	try { return pause(id, reason, closing) }
	finally {
		let running = turns.state.running.get(id)
		if (reason !== undefined && !closing && running) { delete running.steered; running.controller.abort() }
	}
}

function pause(id: string, reason?: string, closing = false): string | undefined {
	let transition = contextTransitions.pending(id)
	contextTransitions.cancel(id)
	let records = history.readSync(id)
	let open = forms.open(records)
	if (!transition && !closing && open && !open.from && open.form.skip) {
		let refused = status.transition(id, { type: 'answer' })
		if (refused) return refused
		history.append(id, { type: 'answer', question: open.id, answers: {}, canceled: true })
		host.broadcast(id, { type: 'answer', sessionId: id, question: open.id, answers: {}, canceled: true })
		turns.start(id)
		return
	}
	if (closing && open && !open.from) {
		history.append(id, { type: 'answer', question: open.id, answers: {}, canceled: true })
		host.broadcast(id, { type: 'answer', sessionId: id, question: open.id, answers: {}, canceled: true })
	}
	if (open?.from) return void slash.dismiss(id, open.id)
	let event: StateEvent = { type: 'pause' }
	if (reason !== undefined) event.reason = reason
	let refused = status.transition(id, event)
	if (refused) return refused
	let running = turns.state.running.get(id)
	if (running) return void (delete running.steered, running.controller.abort())
	if (transition?.kind === 'clear') contextTransitions.settle(id)
	// A turn parked at a question has its usage so far there.
	let end: Omit<HistoryRecord & { type: 'turn_end' }, 'ts'> = { type: 'turn_end', status: 'paused', usage: forms.open(history.readSync(id))?.usage ?? {} }
	if (reason !== undefined) end.pauseReason = reason
	let recorded = history.append(id, end) as HistoryRecord & { type: 'turn_end' }
	let ended: Event = { type: 'turn-end', sessionId: id, status: 'paused', n: recorded.n, ts: recorded.ts, stats: stats.ended(id, recorded) }
	if (Object.keys(end.usage).length) ended.usage = end.usage
	host.broadcast(id, ended)
	contextTransitions.apply(id)
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
// A synthetic model (synthetic.ts) or a dangerous tool call (approval.ts,
// one question at a time, before any call runs) may park the turn at a
// question; run again, it runs the held calls or declines them. A parked
// turn's usage so far is in its question and carried on.
//
// A turn never spirals: after settings.maxRounds() finished rounds it
// pauses with a reason, and continuing gives it as many again. A round
// cut off at max_tokens or refused runs none of its calls and ends the
// turn in error (stopped).
// Points `running` at `model`; returns its effort.
function target(running: Running, model: string, selected?: string): string | undefined {
	running.provider = blocks.parseModelId(model)?.provider ?? model
	running.model = model
	let effort = models.effort(model, selected)
	if (effort !== undefined) running.effort = effort
	else delete running.effort
	return effort
}

// The last prompt-file fault reported per session, so it shows once.
const promptFaults = new Map<string, string>()

async function runTurn(id: string, model: string, running: Running, answers?: Answers): Promise<void> {
	let { signal } = running.controller
	let records = history.readSync(id)
	history.carry(id, running.provider, turns.parkedUsage(records))
	let held = approval.held(records)
	// The scripted reply of the round, read once its stream ended: a
	// stream may settle what to ask while it runs (task b81).
	let replied: Reply | undefined
	async function* stream(): AsyncGenerator<StreamEvent> {
		let scripted = synthetic.find(model)
		if (!scripted) {
			let problems: string[] = []
			let system = systemPrompt.build({ cwd: sessions.open(id).cwd, model: models.qualified(model, running.effort), now: clock.now(), sessionId: id }, problems)
			// A broken prompt file never stops a turn: say so once per distinct fault.
			let fault = problems.join('\n')
			if (fault !== (promptFaults.get(id) ?? '')) {
				promptFaults.set(id, fault)
				if (fault) history.append(id, { type: 'notice', text: `System prompt problems (the rest still applies):\n${fault}` })
			}
			let defs = [actions.def()]
			let messages = await history.messages(id, { overhead: system.length + JSON.stringify(defs).length, window: models.contextWindow(model), model })
			if (signal.aborted) return
			for await (let event of turns.stream(model, { system, effort: running.effort, messages, tools: defs, image: (blob) => blobs.base64(id, blob), sessionId: id }, signal)) {
				if (signal.aborted) return
				yield event.type === 'tool_call' ? { ...actions.arrived({ ...event }), type: 'tool_call' } : event
			}
			return
		}
		let reply = (replied = scripted(await history.read(id), answers, id))
		answers = undefined
		yield* reply.stream ?? synthetic.paced(reply.say, signal)
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
			let transition = contextTransitions.pending(id)
			if (transition?.kind === 'clear') {
				last = transition.canceled ? undefined : { type: 'done', reason: 'end' }
				break
			}
			if (transition?.kind === 'rebase') {
				let paused = (require('./rebase-agent.ts') as typeof import('./rebase-agent.ts')).rebaseAgent.apply(id, transition)
				if (paused) { last = undefined; break }
			}
			if (transition?.kind === 'compact') contextTransitions.apply(id)
			// Aborted work has settled. A steer left a fresh controller
			// (prompts.submit): go on with it. Escape aborted the current one.
			if (signal.aborted) {
				last = undefined
				if (running.controller.signal.aborted) break
				signal = running.controller.signal
			}
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
				// Each round asks the session's model: a /model switch counts
				// from the next request, even inside a turn.
				let now = sessions.open(id)
				target(running, (model = now.model), now.effort)
				let round = blocks.newTurn(running.provider)
				last = undefined
				prompts.steer(id)
				status.transition(id, { type: 'request' })
				for await (let event of history.record(id, running.provider, stream(), running, signal)) {
					blocks.apply(round, event)
					if (event.type === 'done' || event.type === 'error') {
						last = event
						break
					}
					if (signal.aborted) break
					status.transition(id, { type: 'stream' })
					let n = history.streaming(id)
					let ts = history.started(id)
					host.broadcast(id, { type: 'stream', sessionId: id, event, model: running.model, effort: running.effort, ...(n !== undefined && { n }), ...(ts !== undefined && { ts }) })
				}
				let interrupted = history.interrupted(id)
				if (interrupted) host.broadcast(id, { type: 'assistant-interrupted', sessionId: id, record: interrupted })
				if (Object.keys(round.usage).length) host.broadcast(id, { type: 'turn-stats', sessionId: id, stats: stats.round(id, round.usage) })
				if (last?.type === 'error' && !signal.aborted && compact.retry(id, last, shrunk)) {
					shrunk = true
					continue
				}
				if (last?.type === 'error' && last.failure && !last.canceled && !signal.aborted) {
					host.broadcast(id, { type: 'turn-stats', sessionId: id, stats: stats.of(id) })
					await turns.waitOut(id, last, failures++, signal)
					if (turns.state.running.get(id) !== running) return
					continue
				}
				if (signal.aborted) {
					let clear = contextTransitions.pending(id)?.kind === 'clear'
					if (clear || signal.reason === jobs.steered) {
						let results = round.blocks.filter((b) => b.type === 'tool_call').map((b) => clear ? { type: 'tool_result' as const, id: b.id, output: 'Tool call did not run: clear accepted before dispatch.', isError: true } : turnPolicy.canceled(b.id))
						if (results.length) { let r = history.results(id, results); host.broadcast(id, { type: 'tool-results', sessionId: id, results, n: r?.n, ts: r?.ts }) }
					}
					continue
				}
				if (last?.type === 'done') {
					failures = 0
					rounds++
					last = turns.stopped(last)
				}
				if (replied?.ask && last?.type === 'done' && !signal.aborted) return turns.ask(id, replied.ask)
				if (replied?.pause && last?.type === 'done' && !signal.aborted) [capped, last] = [replied.pause, undefined]
				if (capped) break
				calls = round.blocks.filter((b) => b.type === 'tool_call')
				if (last?.type !== 'done') break
				// A finished answer with steering waiting: the model hears it.
				if (!calls.length) {
					if (contextTransitions.pending(id)) continue
					if (signal.aborted || !status.inboxOf(id).some((m) => m.delivery !== 'after-turn')) break
					continue
				}
			}
			if (signal.aborted) continue
			for (let call of calls) {
				let form = decided.has(call.id) ? undefined : approval.form(call)
				if (form) return turns.ask(id, form, call.id)
			}
			let cwd = sessions.open(id).cwd
			status.transition(id, { type: 'tools' })
			let ending = false
			let ctx = { cwd, signal, sessionId: id, endTurn: () => (ending = true) }
			// The round's calls run concurrently; results keep call order.
			// wait starts once the others settle, so it sees children
			// spawned in the same round.
			let runOne = async (call: ToolCallBlock): Promise<ToolResultBlock> => {
				if (signal.aborted && signal.reason === jobs.steered) return turnPolicy.canceled(call.id)
				if (signal.aborted || contextTransitions.pending(id)?.kind === 'clear') return { type: 'tool_result', id: call.id, output: `Tool call did not run: ${jobs.why(signal)} before dispatch.`, isError: true }
				if (decided.get(call.id) === false) return approval.declined(call)
				status.transition(id, { type: 'tools', call: call.id, at: new Date().toISOString() })
				let stream = tools.streams(call) ? toolOutput.start(id, call.id) : undefined
				if (tools.unsafe(call)) (running.unsafe ??= new Map()).set(call.id, { input: call.input, at: Date.now() })
				try { return turnPolicy.stoppedBy(await tools.run(call, stream ? { ...ctx, onOutput: stream.onOutput } : ctx), signal) }
				finally {
					stream?.stop()
					running.unsafe?.delete(call.id)
					if (!running.unsafe?.size) delete running.unsafe
					// A steer that waited for the flagged calls interrupts once none runs.
					if (running.steered && !running.unsafe) { delete running.steered; prompts.interrupt(running) }
				}
			}
			let early = calls.filter((c) => c.name !== 'wait')
			let settled = new Map<string, ToolResultBlock>()
			let run = await edit.batch(calls, cwd, id, runOne)
			for (let r of await Promise.all(early.map(run))) settled.set(r.id, r)
			for (let call of calls) if (!settled.has(call.id)) settled.set(call.id, await run(call))
			let results = calls.map((c) => settled.get(c.id)!)
			if (turns.state.running.get(id) !== running) return
			if (contextTransitions.pending(id)?.kind === 'rebase') {
				let settled = (require('./rebase-agent.ts') as typeof import('./rebase-agent.ts')).rebaseAgent.results(id, results)
				if (settled.paused) { last = undefined; break }
			} else {
				let r = history.results(id, results)
				host.broadcast(id, r?.n === undefined ? { type: 'tool-results', sessionId: id, results, ts: r?.ts } : { type: 'tool-results', sessionId: id, results, n: r.n, ts: r.ts })
			}
			if (signal.aborted) continue
			// A wait: the turn ends, done, unless steering waits to be read.
			if (ending && !status.inboxOf(id).some((m) => m.delivery !== 'after-turn')) {
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
		if (contextTransitions.pending(id)?.kind === 'clear') contextTransitions.settle(id)
		history.end(id, failure !== undefined ? { type: 'error', message: failure } : last, capped)
		recorded = history.readSync(id).at(-1)
	} catch (e: any) {
		failure ??= String(e?.message ?? e)
	}
	let end: Event & { type: 'turn-end' } = { type: 'turn-end', sessionId: id, status: 'error', error: failure ?? 'turn end was not recorded' }
	if (recorded?.type === 'turn_end') {
		end = { type: 'turn-end', sessionId: id, status: recorded.status, ts: recorded.ts }
		if (recorded.n !== undefined) end.n = recorded.n
		if (Object.keys(recorded.usage).length) end.usage = recorded.usage
		if (recorded.error !== undefined) end.error = recorded.error
		end.stats = stats.ended(id, recorded)
	}
	host.broadcast(id, end)
	if (end.status === 'completed' && !notify.asked(id)) neighbors.finished(id)
	// Paused already, unless something other than the user aborted it.
	if (end.status === 'paused') status.transition(id, capped === undefined ? { type: 'pause' } : { type: 'pause', reason: capped })
	else status.transition(id, end.status === 'error' ? { type: 'end', error: end.error ?? 'turn failed' } : { type: 'end' })
	// After the turn's own records, so what it starts lands below them.
	if (end.status === 'paused' && capped !== undefined) replied?.after?.()
	if (contextTransitions.apply(id)) return
	subagents.report(id)
	if (end.status === 'completed') {
		prompts.next(id)
		autoclose.finished(id)
	}
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
	parkedUsage: (...args: Parameters<typeof turnPolicy.parkedUsage>) => turnPolicy.parkedUsage(...args),
	stopped: (...args: Parameters<typeof turnPolicy.stopped>) => turnPolicy.stopped(...args),
	waitOut: (...args: Parameters<typeof turnPolicy.waitOut>) => turnPolicy.waitOut(...args),
	backoffMs: (...args: Parameters<typeof turnPolicy.backoffMs>) => turnPolicy.backoffMs(...args),
}
