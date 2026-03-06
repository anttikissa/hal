// HAL cursor — blinking block at active output positions.
// One blink timer drives all cursors; the caller places them during buildLines().

let visible = true
let timer: ReturnType<typeof setInterval> | null = null
let onBlinkFn: (() => void) | null = null
const BLINK_MS = 530

/** Start blinking. Calls onBlink to trigger re-render. */
export function start(onBlink: () => void): void {
	if (timer) return
	onBlinkFn = onBlink
	visible = true
	timer = setInterval(() => {
		visible = !visible
		onBlink()
	}, BLINK_MS)
}

/** Reset blink timer — call after user input to keep cursor solid. */
export function bump(): void {
	if (!timer || !onBlinkFn) return
	clearInterval(timer)
	visible = true
	timer = setInterval(() => {
		visible = !visible
		onBlinkFn!()
	}, BLINK_MS)
}

/** Stop blinking, reset to invisible. */
export function stop(): void {
	if (timer) { clearInterval(timer); timer = null }
	onBlinkFn = null
	visible = true
}

export function isActive(): boolean { return timer !== null }

/** '█' or ' ' based on blink state. Call per cursor position in buildLines(). */
export function char(): string {
	return visible ? '█' : ' '
}
