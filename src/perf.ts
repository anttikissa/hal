// Performance telemetry — zero-cost when not observed.
// Call perf.mark() anywhere. Marks are timestamped and accumulated in memory.
// If a sink is configured, marks are flushed periodically (not on every call).

const marks: Array<{ name: string; ts: number; detail?: string }> = []
const epoch = Number(process.env.HAL_STARTUP_TIMESTAMP) || Date.now()
let sink: ((lines: string[]) => void) | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null

function mark(name: string, detail?: string): void {
	marks.push({ name, ts: performance.now(), detail })
}

function setSink(fn: (lines: string[]) => void, intervalMs = 100): void {
	sink = fn
	if (flushTimer) clearInterval(flushTimer)
	flushTimer = setInterval(flush, intervalMs)
}

function flush(): void {
	if (!sink || marks.length === 0) return
	const lines = marks.splice(0).map((m) => {
		const sinceStart = (m.ts + performance.timeOrigin - epoch).toFixed(1)
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

export const perf = { mark, setSink, flush, stop, elapsed }
