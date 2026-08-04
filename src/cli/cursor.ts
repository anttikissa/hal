// Wall-clock-synced 250ms pulse clock for rendered cursor indicators.
// Slow cursors derive a 500ms blink from the same tick, while streaming cursors
// can use the raw 250ms phase without a second timer.

let timer: ReturnType<typeof setTimeout> | null = null
let onChange: (() => void) | null = null

function tick(): number {
	return Math.floor(Date.now() / 250)
}

function isVisible(): boolean {
	return tick() % 4 < 2
}

function isFastVisible(): boolean {
	return tick() % 2 === 0
}

function scheduleNext(): void {
	if (!onChange) return
	const now = Date.now()
	// Jump to the next shared 250ms boundary so every indicator uses the same
	// phase instead of drifting based on when start() was called.
	const next = Math.ceil((now + 1) / 250) * 250
	timer = setTimeout(() => {
		onChange?.()
		scheduleNext()
	}, next - now)
}

function start(onPhaseChange: () => void): void {
	stop()
	onChange = onPhaseChange
	scheduleNext()
}

function stop(): void {
	if (timer) clearTimeout(timer)
	timer = null
	onChange = null
}

export const cursor = { isVisible, isFastVisible, start, stop }
