// The one pulse every blink in the terminal follows (the Hal cursor,
// later the tab indicators). Beats are wall-clock quarter seconds, so
// everything that blinks is in phase. The timer runs only while someone
// keeps it: `keep(fn)` while something on screen blinks, `keep(null)`
// once nothing does. Each beat calls the keeper, which repaints; the
// renderer writes only the rows that changed.

// The beat now: a count of `ms()` periods since the epoch.
function beat(): number {
	return Math.floor(pulse.now() / pulse.ms)
}

// Lit on every other beat (a streaming cursor).
const fast = (b: number): boolean => b % 2 === 0

// Lit two beats, dark two (the idle cursor, blinking indicators).
const slow = (b: number): boolean => b % 4 < 2

function schedule(): void {
	let now = pulse.now()
	let next = (Math.floor(now / pulse.ms) + 1) * pulse.ms
	let st = pulse.state
	st.timer = setTimeout(() => {
		st.timer = null
		let fn = st.onBeat
		if (!fn) return
		pulse.schedule()
		fn(next / pulse.ms)
	}, Math.max(1, next - now))
	// Blinking alone never keeps a process alive.
	;(st.timer as { unref?: () => void }).unref?.()
}

// Calls `fn` on every beat from now on; null stops the timer.
function keep(fn: ((beat: number) => void) | null): void {
	pulse.state.onBeat = fn
	let st = pulse.state
	if (!fn && st.timer) {
		clearTimeout(st.timer)
		st.timer = null
	}
	if (fn && !st.timer) pulse.schedule()
}

const running = (): boolean => pulse.state.timer !== null

export const pulse = {
	state: { onBeat: null as ((beat: number) => void) | null, timer: null as ReturnType<typeof setTimeout> | null },
	/** One beat's length. */
	ms: 250,
	now: () => Date.now(),
	beat,
	fast,
	slow,
	schedule,
	keep,
	running,
	/** Stop (tests). */
	reset: (): void => pulse.keep(null),
}
