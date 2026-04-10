// Wall-clock-synced 500ms pulse clock for status indicators.
// Phase changes land on every x.000 and x.500 second boundary so all tabs stay
// in sync even if they started blinking at different times.

let timer: ReturnType<typeof setTimeout> | null = null
let onChange: (() => void) | null = null

function isVisible(): boolean {
	return Math.floor(Date.now() / 500) % 2 === 0
}

function scheduleNext(): void {
	if (!onChange) return
	const now = Date.now()
	// Jump to the next shared 500ms boundary so every indicator uses the same
	// phase instead of drifting based on when start() was called.
	const next = Math.ceil((now + 1) / 500) * 500
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
