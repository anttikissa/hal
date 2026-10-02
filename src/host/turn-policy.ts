// Turn completion and retry policy, shared by the turn loop (task jf).
import type { DoneEvent, ErrorEvent, Usage } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { history } from './history.ts'
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
	// Output cut off mid-answer: the model hears it was interrupted.
	if (history.readSync(id).at(-1)?.type === 'assistant') history.append(id, { type: 'continue' })
	if (error.failure === 'auth' && error.retryAt === undefined) {
		status.transition(id, { type: 'block', reason: `log in: ${error.message}` })
		await auth.changed(signal)
		return
	}
	let at = error.retryAt ?? clock.now() + turns.backoffMs(failures)
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

export const turnPolicy = { stopped, parkedUsage, waitOut, waitFor, backoffMs }
