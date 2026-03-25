// Wall-clock-synced 500ms blink for status indicators (tab bar busy dots, etc.).
// Phase changes at every x.000 and x.500 second boundary so multiple
// indicators blink in sync.

let timer: ReturnType<typeof setTimeout> | null = null
let onChange: (() => void) | null = null

function isVisible(): boolean {
	return Math.floor(Date.now() / 500) % 2 === 0
}

function scheduleNext(): void {
	const now = Date.now()
	// Next phase boundary: ceil to nearest 500ms
	const next = Math.ceil((now + 1) / 500) * 500
	timer = setTimeout(() => {
		onChange?.()
		scheduleNext()
	}, next - now)
}

function start(onPhaseChange: () => void): void {
	onChange = onPhaseChange
	scheduleNext()
}

function stop(): void {
	if (timer) clearTimeout(timer)
	timer = null
	onChange = null
}

export const cursor = { isVisible, start, stop }
