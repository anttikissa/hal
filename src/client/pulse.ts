// The one pulse every blink in the terminal follows (the Hal cursor,
// later the tab indicators). Blink beats stay on wall-clock quarter
// seconds; a live tool can also request finer frame boundaries. The
// timer runs only while someone keeps it and the renderer writes only
// rows that changed.

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
	let st = pulse.state
	let next = Math.min((Math.floor(now / pulse.ms) + 1) * pulse.ms, (Math.floor(now / st.interval) + 1) * st.interval)
	st.timer = setTimeout(
		() => {
			st.timer = null
			let fn = st.onBeat
			if (!fn) return
			pulse.schedule()
			fn(Math.floor(next / pulse.ms))
		},
		Math.max(1, next - now),
	)
	// Blinking alone never keeps a process alive.
	;(st.timer as { unref?: () => void }).unref?.()
}

// Calls `fn` on beat and requested frame boundaries; null stops it.
function keep(fn: ((beat: number) => void) | null, interval = pulse.ms): void {
	pulse.state.onBeat = fn
	let st = pulse.state
	if ((!fn || interval !== st.interval) && st.timer) {
		clearTimeout(st.timer)
		st.timer = null
	}
	st.interval = interval
	if (fn && !st.timer) pulse.schedule()
}

const running = (): boolean => pulse.state.timer !== null

export const pulse = {
	state: {
		onBeat: null as ((beat: number) => void) | null,
		timer: null as ReturnType<typeof setTimeout> | null,
		interval: 250,
	},
	/** One beat's length. */
	ms: 250,
	// Animations (rotating examples) repaint on finer wall-clock frames:
	// 50 ms (20 Hz) is 3 refreshes of a 60 Hz display (6 at 120 Hz) and a
	// fifth of a beat, so frames and blinks fall together. 30 Hz would
	// not divide a beat.
	frame: 50,
	/** Ms from now to the first frame at least `ms` away. */
	until: (ms: number): number => {
		let now = pulse.now()
		return Math.max(1, Math.ceil((now + ms) / pulse.frame) * pulse.frame - now)
	},
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
