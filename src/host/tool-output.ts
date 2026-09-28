// Foreground bash output in progress: display only, not history or model
// input. Send new bytes at most 10 times per second; snapshots read state.
import { host } from './host.ts'

type Partial = { id: string; output: string }

function start(session: string, id: string) {
	toolOutput.state.set(session, { id, output: '' })
	let pending = ''
	let timer: ReturnType<typeof setTimeout> | undefined
	let last = 0
	let send = () => {
		timer = undefined
		if (!pending) return
		let chunk = pending
		pending = ''
		last = Date.now()
		host.broadcast(session, { type: 'tool-output', sessionId: session, id, at: toolOutput.state.get(session)!.output.length - chunk.length, chunk })
	}
	return {
		onOutput(chunk: string) {
			let current = toolOutput.state.get(session)
			if (!current || current.id !== id) return
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
			toolOutput.state.delete(session)
		},
	}
}

export const toolOutput = { state: new Map<string, Partial>(), start }
