// Foreground bash output in progress: display only, not history or model
// input. Calls of a round run concurrently, so each session may stream
// several at once, keyed by call id. Send new bytes at most 10 times per
// second; snapshots read state.
import { host } from './host.ts'

type Partial = { id: string; output: string }

function of(session: string): Partial[] {
	return [...(toolOutput.state.get(session)?.values() ?? [])].filter((p) => p.output)
}

function start(session: string, id: string) {
	let calls = toolOutput.state.get(session) ?? new Map<string, Partial>()
	toolOutput.state.set(session, calls)
	let current: Partial = { id, output: '' }
	calls.set(id, current)
	let pending = ''
	let timer: ReturnType<typeof setTimeout> | undefined
	let last = 0
	let send = () => {
		timer = undefined
		if (!pending) return
		let chunk = pending
		pending = ''
		last = Date.now()
		host.broadcast(session, { type: 'tool-output', sessionId: session, id, at: current.output.length - chunk.length, chunk })
	}
	return {
		onOutput(chunk: string) {
			if (toolOutput.state.get(session)?.get(id) !== current) return
			// Bound the preview even for an endless command; its final result
			// still includes everything and may be recovered from a blob.
			let added = chunk.slice(0, Math.max(0, 1_000_000 - current.output.length))
			if (!added) return
			current.output += added
			pending += added
			if (!timer) {
				let wait = Math.max(0, 100 - (Date.now() - last))
				if (wait) timer = setTimeout(send, wait)
				else send()
			}
		},
		stop() {
			if (timer) clearTimeout(timer)
			pending = ''
			let calls = toolOutput.state.get(session)
			if (calls?.get(id) !== current) return
			calls.delete(id)
			if (!calls.size) toolOutput.state.delete(session)
		},
	}
}

export const toolOutput = { state: new Map<string, Map<string, Partial>>(), start, of }
