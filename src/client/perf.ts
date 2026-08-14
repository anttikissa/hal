// Performance telemetry — zero-cost when not observed.
// Call perf.mark() anywhere. Marks are timestamped and accumulated in memory.
// If a sink is configured, marks are flushed periodically (not on every call).
//
// Extended: trace() returns a full waterfall, summary() returns a one-liner.
// Controlled by HAL_PERF=1 env var (trace output to sink).

interface Mark {
	name: string
	ts: number // performance.now() at time of mark
	detail?: string
}

const allMarks: Mark[] = []
const pending: Mark[] = []
const epoch = Number(process.env.HAL_STARTUP_TIMESTAMP) || Date.now()
const enabled = !!process.env.HAL_PERF
let sink: ((lines: string[]) => void) | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null

// Absolute ms since epoch for a given performance.now() timestamp
function absMs(ts: number): number {
	return ts + performance.timeOrigin - epoch
}

function mark(name: string, detail?: string): void {
	const m: Mark = { name, ts: performance.now(), detail }
	allMarks.push(m)
	pending.push(m)
}

function setSink(fn: (lines: string[]) => void, intervalMs = 100): void {
	sink = fn
	if (flushTimer) clearInterval(flushTimer)
	flushTimer = setInterval(flush, intervalMs)
}

function flush(): void {
	if (!sink || pending.length === 0) return
	const lines = pending.splice(0).map((m) => {
		const sinceStart = absMs(m.ts).toFixed(1)
		const detail = m.detail ? ` (${m.detail})` : ''
		return `${sinceStart}ms  ${m.name}${detail}`
	})
	sink(lines)
}

function stop(): void {
	flush()
	if (flushTimer) {
		clearInterval(flushTimer)
		flushTimer = null
	}
}

function elapsed(): number {
	return Date.now() - epoch
}

function snapshot(): Array<{ name: string; ms: number; detail?: string }> {
	return allMarks.map((m) => ({ name: m.name, ms: absMs(m.ts), detail: m.detail }))
}

// ── Trace waterfall ──────────────────────────────────────────────────────────
// Returns a formatted multi-line string showing all marks with deltas
// and a simple visual bar. Useful for startup diagnostics.

function trace(): string {
	if (allMarks.length === 0) return '(no perf marks)'
	const lines: string[] = []
	let prevMs = 0
	const marks = snapshot()
	const maxMs = marks[marks.length - 1]?.ms ?? 1
	const barWidth = 20

	for (const m of marks) {
		const delta = m.ms - prevMs
		const barLen = maxMs > 0 ? Math.round((delta / maxMs) * barWidth) : 0
		const bar = '\u2588'.repeat(Math.max(barLen, 0))
		const detail = m.detail ? ` (${m.detail})` : ''
		const msStr = m.ms.toFixed(0).padStart(6)
		const deltaStr = delta > 0 ? ` +${delta.toFixed(0)}ms` : ''
		lines.push(`${msStr}ms ${bar.padEnd(barWidth)} ${m.name}${deltaStr}${detail}`)
		prevMs = m.ms
	}
	return lines.join('\n')
}

// One-line summary: "Started in Xms (Y marks)"
function summary(): string {
	const marks = snapshot()
	if (marks.length === 0) return 'No perf data'
	const totalMs = marks[marks.length - 1]!.ms
	return `Started in ${totalMs.toFixed(0)}ms (${marks.length} marks)`
}

function reset(): void {
	allMarks.length = 0
	pending.length = 0
}

export const perf = { mark, setSink, flush, stop, elapsed, snapshot, trace, summary, reset, enabled }
