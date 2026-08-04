// Wall-clock-synced 250ms pulse clock for status indicators.
// Phase changes land on every quarter-second boundary so all tabs stay in sync
// even if they started blinking at different times.

let timer: ReturnType<typeof setTimeout> | null = null
let onChange: (() => void) | null = null

function isVisible(): boolean {
	return Math.floor(Date.now() / 250) % 2 === 0
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

export const cursor = { isVisible, start, stop }
