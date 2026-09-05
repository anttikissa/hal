// Process exits are requests followed by an explicit durability boundary.
// Callers persist their output first, then call exitIfRequested(). This avoids
// guessing how many milliseconds filesystem or IPC work might take.

const RESTART_EXIT_CODE = 100

let state = {
	exitCode: null as number | null,
	nextTurnScheduled: false,
}

let io = {
	exit(code: number): void {
		process.exit(code)
	},
}

/** Record an exit request. The first request wins until a durability boundary flushes it. */
function requestExit(code: number): void {
	if (state.exitCode === null) state.exitCode = code
}

/** Request the same wrapper restart as Ctrl-R. The caller must later flush at a durable boundary. */
function requestRestart(): void {
	processControl.requestExit(RESTART_EXIT_CODE)
}

/** Exit only after the caller has synchronously persisted all preceding state and output. */
function exitIfRequested(): void {
	if (state.exitCode === null) return
	const code = state.exitCode
	state.exitCode = null
	processControl.io.exit(code)
}

/**
 * Let the current event-loop turn return before exiting. setImmediate is a
 * deterministic phase boundary, unlike a guessed timer. Use this only where
 * a disconnect is acceptable; it does not pretend to guarantee delivery.
 */
function exitOnNextTurn(): void {
	if (state.exitCode === null || state.nextTurnScheduled) return
	state.nextTurnScheduled = true
	setImmediate(() => {
		state.nextTurnScheduled = false
		processControl.exitIfRequested()
	})
}

export const processControl = { state, io, requestExit, requestRestart, exitIfRequested, exitOnNextTurn }
