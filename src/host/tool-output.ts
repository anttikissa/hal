// Bash output in progress: display only, not history or model input.
// Calls of a round run concurrently, so each session may stream several
// at once, keyed by call id; a background job's stream outlives its call
// (task 6nn). Send new bytes at most 10 times per second; snapshots
// read state.
import { host } from './host.ts'

// `from`: how many characters before `output` were dropped.
type Partial = { id: string; output: string; from: number }

function of(session: string): Partial[] {
	return [...(toolOutput.state.get(session)?.values() ?? [])].filter((p) => p.output)
}

function start(session: string, id: string) {
	let calls = toolOutput.state.get(session) ?? new Map<string, Partial>()
	toolOutput.state.set(session, calls)
	let current: Partial = { id, output: '', from: 0 }
	calls.set(id, current)
	let pending = ''
	let timer: ReturnType<typeof setTimeout> | undefined
	let last = 0
	let held = false
	let send = () => {
		timer = undefined
		if (!pending) return
		let chunk = pending
		pending = ''
		last = Date.now()
		host.broadcast(session, {
			type: 'tool-output',
			sessionId: session,
			id,
			at: current.from + current.output.length - chunk.length,
			chunk,
		})
	}
	let stop = () => {
		if (timer) clearTimeout(timer)
		pending = ''
		let calls = toolOutput.state.get(session)
		if (calls?.get(id) !== current) return
		calls.delete(id)
		if (!calls.size) toolOutput.state.delete(session)
	}
	return {
		onOutput(chunk: string) {
			if (toolOutput.state.get(session)?.get(id) !== current) return
			// Bound the preview even for an endless command by keeping its
			// newest part; its final result is kept apart. Trim only once
			// twice over, so trimming costs O(1) per byte.
			let max = toolOutput.maxChars
			current.output += chunk
			pending += chunk
			if (current.output.length > 2 * max) {
				current.from += current.output.length - max
				current.output = current.output.slice(-max)
			}
			if (pending.length > current.output.length) pending = pending.slice(-current.output.length)
			if (!timer) {
				let wait = Math.max(0, 100 - (Date.now() - last))
				if (wait) timer = setTimeout(send, wait)
				else send()
			}
		},
		// Ends the stream, unless a background job holds it.
		stop() {
			if (!held) stop()
		},
		// A background job takes the stream over; it calls the returned end.
		hold(): () => void {
			held = true
			return stop
		},
	}
}

export const toolOutput = { state: new Map<string, Map<string, Partial>>(), start, of, maxChars: 1_000_000 }
