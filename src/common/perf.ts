// Startup telemetry: perf.mark() anywhere keeps a timestamped mark in
// memory; /perf shows them as a waterfall (perf.trace()). Times count
// from perf.state.epoch, which main sets from HAL_STARTUP_TIMESTAMP
// (./run's start, before Bun's own), so they include process startup.
// Browser-safe: only the Web `performance` clock.

type Mark = { name: string; ms: number; detail?: string }

// Milliseconds since the epoch, now.
function now(): number {
	return performance.timeOrigin + performance.now()
}

// Kept up to maxMarks: a mark hit on every reconnect must not grow forever.
function mark(name: string, detail?: string): void {
	if (perf.state.marks.length >= perf.maxMarks) return
	let m: Mark = { name, ms: perf.now() - perf.state.epoch }
	if (detail) m.detail = detail
	perf.state.marks.push(m)
}

// The marks, one line each: time since the epoch, a bar for the time
// since the previous mark (scaled to the whole run), name, delta, detail.
function trace(): string {
	let marks = perf.state.marks
	if (!marks.length) return '(no perf marks)'
	let total = Math.max(marks.at(-1)!.ms, 1)
	let prev = 0
	return marks
		.map((m) => {
			let delta = m.ms - prev
			prev = m.ms
			let bar = '█'.repeat(Math.max(0, Math.round((delta / total) * 20)))
			let plus = delta >= 1 ? ` +${delta.toFixed(0)}ms` : ''
			return `${m.ms.toFixed(0).padStart(6)}ms ${bar.padEnd(20)} ${m.name}${plus}${m.detail ? ` (${m.detail})` : ''}`
		})
		.join('\n')
}

// Stall watchdog (task 7j): a timer due every `tick` ms that fires late
// means the event loop was blocked; each block over `limit` ms goes to
// `report` with its length and when it ended (ms since the epoch). A
// stop function is returned. Costs one timer; used by scripts/perf.
function watch(report: (ms: number, at: number) => void, limit = 10, tick = 5): () => void {
	let due = performance.now() + tick
	let timer = setInterval(() => {
		let now = performance.now()
		let late = now - due
		due = now + tick
		if (late > limit) report(late, perf.now() - perf.state.epoch)
	}, tick)
	;(timer as { unref?: () => void }).unref?.()
	return () => clearInterval(timer)
}

export const perf = { state: { epoch: performance.timeOrigin, marks: [] as Mark[] }, maxMarks: 500, now, mark, trace, watch }
