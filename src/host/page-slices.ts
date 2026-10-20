// Runs history-reading steps (pages.ts) in time slices, so decoding a big
// history never blocks the event loop (task 7j). Small reads finish
// synchronously.
import { pages } from './pages.ts'

type Steps<T> = Generator<number, T, void>

function deadline(): number {
	if (pages.state.until === undefined) {
		pages.state.until = performance.now() + pages.sliceMs
		setImmediate(() => (pages.state.until = undefined))
	}
	return pages.state.until
}

function slices<T>(steps: Steps<T>): T | Promise<T> {
	let decoded = 0
	let run = (): IteratorResult<number, T> | undefined => {
		for (;;) {
			let small = decoded <= pages.syncBytes
			if (!small && performance.now() >= pages.deadline()) return undefined
			let r = steps.next()
			if (r.done) return r
			decoded += r.value
			let now = performance.now()
			let end = pages.deadline()
			if (decoded > pages.syncBytes && now > end - pages.sliceMs + 0.5 && now + (r.value / 1e6) * pages.msPerMB > end)
				return undefined
		}
	}
	let r = run()
	if (r) return r.value as T
	let next = () => new Promise((resolve) => setImmediate(resolve))
	return (async () => {
		for (;;) {
			await next()
			let r = run()
			if (!r) continue
			if (performance.now() >= pages.deadline()) await next()
			return r.value as T
		}
	})()
}

export const pageSlices = { deadline, slices }
