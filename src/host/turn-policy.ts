// Turn completion and retry policy, shared by the turn loop (task jf).
import type { DoneEvent, ErrorEvent, ToolResultBlock, Usage } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { jobs } from './jobs.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { statusUsage } from './status-usage.ts'
import { turns } from './turns.ts'

// A round's end as the turn takes it: one cut off (max_tokens, or the
// context window) or refused is an error saying why, so none of its
// tool calls runs; any other end stands.
function stopped(done: DoneEvent): DoneEvent | ErrorEvent {
	if (done.reason === 'max_tokens') return { type: 'error', message: 'Response stopped: max_tokens' }
	if (done.reason === 'refusal') return { type: 'error', message: `Refused: ${done.explanation ?? 'the provider gave no explanation'}` }
	return done
}

// Steering cancelled or stopped a call (task ker): not a failure, but
// the model reads what happened.
function cancelled(id: string): ToolResultBlock {
	return { type: 'tool_result', id, output: `Tool call did not run: cancelled ${jobs.byMessage}.`, interrupted: 'cancelled' }
}
function stoppedBy(result: ToolResultBlock, signal: AbortSignal): ToolResultBlock {
	if (signal.reason !== jobs.steered || !result.output.includes(jobs.byMessage)) return result
	let { isError: _, ...rest } = result
	return { ...rest, interrupted: 'stopped' }
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
// login). Ends early on Escape (`signal`); a wake or a model switch
// (the new model may not share the failure) retries at once.
async function waitOut(id: string, error: ErrorEvent, failures: number, outer: AbortSignal): Promise<void> {
	let running = turns.state.running.get(id)
	let rewait = new AbortController()
	if (running) running.rewait = rewait
	let signal = AbortSignal.any([outer, rewait.signal])
	try { await turnPolicy.waitFor(id, error, failures, signal) }
	finally { if (running?.rewait === rewait) delete running.rewait }
}

async function waitFor(id: string, error: ErrorEvent, failures: number, signal: AbortSignal): Promise<void> {
	// Partial output can be followed by usage/bookkeeping, not only an assistant record.
	if (history.readSync(id).findLast((r) => r.type === 'assistant' || r.type === 'user' || r.type === 'continue')?.type === 'assistant') history.append(id, { type: 'continue', reason: `Hal is retrying after the response stopped: ${error.message}${error.body && !error.message.includes(error.body) ? `\n${error.body}` : ''}` })
	if (error.failure === 'auth' && error.retryAt === undefined) {
		status.transition(id, { type: 'block', reason: `log in: ${error.message}` })
		await auth.changed(signal)
		return
	}
	let at = error.retryAt ?? clock.now() + turns.backoffMs(failures)
	if (error.failure === 'limited' && at > clock.now()) {
		let model = sessions.open(id).model
		let provider = turns.state.running.get(id)?.provider ?? model.split('/')[0]!
		let until = new Date(at).toISOString()
		let text = `Rate limit: ${provider}, ${model}, until ${until}\n${error.message}`
		let r = history.append(id, { type: 'rate_limit', provider, model, until, text })
		host.broadcast(id, { type: 'output', sessionId: id, text, ts: r.ts, n: r.n })
	}
	status.transition(id, { type: 'retry', at: new Date(at).toISOString(), reason: error.message })
	if (error.failure !== 'limited' || at <= clock.now()) return clock.until(at, signal)
	void statusUsage.recheck(turns.state.running.get(id)?.provider ?? '')
	// A new account can lift quota before the old account's reset time.
	let waiting = new AbortController()
	let either = AbortSignal.any([signal, waiting.signal])
	try { await Promise.race([clock.until(at, either), auth.changed(either)]) }
	finally { waiting.abort() }
}

// The wait before the next try after `failures` failed rounds in a
// row: none at first, then doubling up to half a minute.
function backoffMs(failures: number): number {
	return failures === 0 ? 0 : Math.min(1000 * 2 ** (failures - 1), 30_000)
}

export const turnPolicy = { stopped, cancelled, stoppedBy, parkedUsage, waitOut, waitFor, backoffMs }
