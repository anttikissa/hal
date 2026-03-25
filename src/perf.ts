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

const allMarks: Mark[] = [] // every mark ever recorded (for trace/summary)
const pending: Mark[] = [] // marks not yet flushed to sink
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

// ── Trace waterfall ──────────────────────────────────────────────────────────
// Returns a formatted multi-line string showing all marks with deltas
// and a simple visual bar. Useful for startup diagnostics.

function trace(): string {
	if (allMarks.length === 0) return '(no perf marks)'
	const lines: string[] = []
	let prevMs = 0
	// Find the max elapsed for scaling the bar chart
	const maxMs = allMarks.length > 0 ? absMs(allMarks[allMarks.length - 1]!.ts) : 1
	const barWidth = 20 // max bar length in chars

	for (const m of allMarks) {
		const ms = absMs(m.ts)
		const delta = ms - prevMs
		// Scale bar proportionally to total time
		const barLen = maxMs > 0 ? Math.round((delta / maxMs) * barWidth) : 0
		const bar = '\u2588'.repeat(Math.max(barLen, 0))
		const detail = m.detail ? ` (${m.detail})` : ''
		// Right-align the ms values for readability
		const msStr = ms.toFixed(0).padStart(6)
		const deltaStr = delta > 0 ? ` +${delta.toFixed(0)}ms` : ''
		lines.push(`${msStr}ms ${bar.padEnd(barWidth)} ${m.name}${deltaStr}${detail}`)
		prevMs = ms
	}
	return lines.join('\n')
}

// One-line summary: "Started in Xms (Y marks)"
function summary(): string {
	if (allMarks.length === 0) return 'No perf data'
	const totalMs = absMs(allMarks[allMarks.length - 1]!.ts)
	return `Started in ${totalMs.toFixed(0)}ms (${allMarks.length} marks)`
}

export const perf = { mark, setSink, flush, stop, elapsed, trace, summary, enabled }
