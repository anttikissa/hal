// HAL cursor — blinking block at active output positions.
// One blink timer drives all cursors; the caller places them during buildLines().

let visible = true
let timer: ReturnType<typeof setInterval> | null = null

/** Start blinking. Calls onBlink every 250ms to trigger re-render. */
export function start(onBlink: () => void): void {
	if (timer) return
	visible = true
	timer = setInterval(() => {
		visible = !visible
		onBlink()
	}, 250)
}

/** Stop blinking, reset to invisible. */
export function stop(): void {
	if (timer) { clearInterval(timer); timer = null }
	visible = true
}

export function isActive(): boolean { return timer !== null }

/** '█' or ' ' based on blink state. Call per cursor position in buildLines(). */
export function char(): string {
	return visible ? '█' : ' '
}
