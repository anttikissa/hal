// Time for retries, rate limits and wake detection, in one replaceable
// place so tests can inject a clock (override now and sleep).
//
// Laptop sleep (tasks/j1/states.md, Failures) must be invisible to the
// user. This is the one place where defensive, hard-to-test code is
// allowed: timers are unreliable across a sleep (they may fire late, or
// early against wall time), and TCP connections open across it are
// usually dead without any error. So a ticker notices the gap a sleep
// leaves between ticks and tells listeners (provider.stream drops open
// streams, waits re-check the time); and every wait is cut into short
// slices that re-check wall time, so a wait never oversleeps by the
// length of the sleep either.

type Listener = () => void

// Resolves after `ms` or at once when `signal` aborts; never rejects.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve()
		let done = () => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', done)
			resolve()
		}
		let timer = setTimeout(done, ms)
		signal?.addEventListener('abort', done)
	})
}

// Waits until wall time `at` (epoch ms), an abort, or a wake: after a
// sleep the reason for waiting (a dead network, a stale rate limit
// time) may be gone, so the caller should look again at once.
async function until(at: number, signal?: AbortSignal): Promise<void> {
	let woke = false
	let off = clock.onWake(() => (woke = true))
	try {
		// Guard for sleep: short slices, each re-reading wall time.
		while (!woke && !signal?.aborted && clock.now() < at)
			await clock.sleep(Math.min(at - clock.now(), clock.tickMs), signal)
	} finally {
		off()
	}
}

function onWake(fn: Listener): () => void {
	clock.state.listeners.add(fn)
	return () => clock.state.listeners.delete(fn)
}

// One tick of the wake detector. Wall time keeps running while the
// machine sleeps; monotonic time (performance.now) stops. A busy
// process delays ticks but advances both alike, so it is no wake.
function tick(): void {
	let now = clock.now()
	let mono = clock.mono()
	let last = clock.state.last
	let lastMono = clock.state.lastMono
	clock.state.last = now
	clock.state.lastMono = mono
	if (last !== null && now - last - (mono - lastMono) > clock.wakeGapMs) clock.wake()
}

function wake(): void {
	// A copy: a listener may unsubscribe while this runs.
	for (let fn of Array.from(clock.state.listeners)) {
		try {
			fn()
		} catch {}
	}
}

// Starts the wake detector. Idempotent; the timer does not keep the
// process alive.
function init(): void {
	if (clock.state.timer) return
	clock.state.last = clock.now()
	clock.state.lastMono = clock.mono()
	clock.state.timer = setInterval(() => clock.tick(), clock.tickMs)
	clock.state.timer.unref?.()
}

function stop(): void {
	if (clock.state.timer) clearInterval(clock.state.timer)
	clock.state.timer = null
	clock.state.last = null
}

export const clock = {
	now: (): number => Date.now(),
	mono: (): number => performance.now(),
	sleep,
	until,
	// Wake detector period, and how much sleep counts as a wake.
	tickMs: 1000,
	wakeGapMs: 4000,
	onWake,
	tick,
	wake,
	init,
	stop,
	state: {
		listeners: new Set<Listener>(),
		last: null as number | null,
		lastMono: 0,
		timer: null as ReturnType<typeof setInterval> | null,
	},
}
