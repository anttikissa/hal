// Startup telemetry. Call perf.mark() anywhere; marks are timestamped and kept
// in memory. `/perf` (and eval) render them as a waterfall with perf.trace().

interface Mark {
	name: string
	ts: number // performance.now() at time of mark
	detail?: string
}

const allMarks: Mark[] = []
// The launcher script records the wall-clock time before Bun starts, so marks
// can include process startup, not just time since this module loaded.
const epoch = Number(process.env.HAL_STARTUP_TIMESTAMP) || Date.now()

// Absolute ms since epoch for a given performance.now() timestamp
function absMs(ts: number): number {
	return ts + performance.timeOrigin - epoch
}

function mark(name: string, detail?: string): void {
	allMarks.push({ name, ts: performance.now(), detail })
}

// Formatted multi-line waterfall of all marks with deltas and a visual bar.
function trace(): string {
	if (allMarks.length === 0) return '(no perf marks)'
	const lines: string[] = []
	let prevMs = 0
	const maxMs = absMs(allMarks[allMarks.length - 1]!.ts)
	const barWidth = 20

	for (const m of allMarks) {
		const ms = absMs(m.ts)
		const delta = ms - prevMs
		const barLen = maxMs > 0 ? Math.round((delta / maxMs) * barWidth) : 0
		const bar = '\u2588'.repeat(Math.max(barLen, 0))
		const detail = m.detail ? ` (${m.detail})` : ''
		const deltaStr = delta > 0 ? ` +${delta.toFixed(0)}ms` : ''
		lines.push(`${ms.toFixed(0).padStart(6)}ms ${bar.padEnd(barWidth)} ${m.name}${deltaStr}${detail}`)
		prevMs = ms
	}
	return lines.join('\n')
}

export const perf = { mark, trace }
