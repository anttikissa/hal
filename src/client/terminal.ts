// The client's terminal: raw mode, input, and the emergency keys.
//
// Every stdin chunk is scanned for Ctrl-C (quit), Ctrl-Z (suspend) and
// Ctrl-R (restart) before it reaches the key decoder, and they are handled
// right there, synchronously, without asking the host. Quit and restart
// restore the terminal but never clear it, so the last frame stays on
// screen; restart exits with restartCode, which ./run answers by starting
// again. See the invariants in tasks/README.md.
import { emergency, type EmergencyAction, type EmergencyState } from './emergency.ts'
import { keys, type DecoderState, type KeyEvent } from './keys.ts'
import { ansi } from './ansi.ts'

/** The process and tty operations the terminal needs; faked in tests. */
export interface TerminalIO {
	setRawMode(on: boolean): void
	onData(fn: (chunk: string | Uint8Array) => void): void
	write(s: string): void
	exit(code: number): void
	/** Stop this process like a shell job (SIGSTOP). */
	stop(): void
	onContinue(fn: () => void): void
	/** Runs on every way out: exit, crash, SIGTERM, SIGHUP. */
	onExit(fn: () => void): void
	size(): { rows: number; cols: number }
	onResize(fn: () => void): void
}

interface TerminalState {
	io: TerminalIO | null
	decoder: DecoderState
	emergency: EmergencyState
	/** Raw mode and our terminal modes are on. */
	entered: boolean
	suspended: boolean
	/** Resolves a lone ESC once input goes idle (keys.flush). */
	escapeTimer: ReturnType<typeof setTimeout> | null
}

const BRACKETED_PASTE_ON = '\x1b[?2004h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'
// Kitty keyboard protocol: push "disambiguate escape codes", pop it.
const KITTY_ON = '\x1b[>1u'
const KITTY_OFF = '\x1b[<u'
const SHOW_CURSOR = '\x1b[?25h'

function createState(): TerminalState {
	return { io: null, decoder: keys.createState(), emergency: emergency.createState(), entered: false, suspended: false, escapeTimer: null }
}

function realIO(): TerminalIO {
	return {
		setRawMode: (on) => process.stdin.setRawMode(on),
		onData(fn) {
			process.stdin.on('data', fn)
			process.stdin.resume()
		},
		write: (s) => process.stdout.write(s),
		exit: (code) => process.exit(code),
		stop() {
			// The whole process group, as a shell job would be stopped.
			try {
				process.kill(0, 'SIGSTOP')
			} catch {
				process.kill(process.pid, 'SIGSTOP')
			}
		},
		onContinue: (fn) => process.on('SIGCONT', fn),
		onExit(fn) {
			// Uncaught errors still emit 'exit'; these signals do not.
			process.on('exit', fn)
			// A deliberate quit, like Ctrl-C (tasks/j1/states.md).
			process.on('SIGTERM', () => terminal.quit(143))
			process.on('SIGHUP', () => terminal.quit(129))
			// A restart from outside (`kill -USR1 <pid>`), as Ctrl-R would.
			process.on('SIGUSR1', () => terminal.restart())
		},
		size: () => ({ rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 }),
		onResize: (fn) => process.stdout.on('resize', fn),
	}
}

function enter(): void {
	let io = terminal.state.io!
	io.setRawMode(true)
	io.write((terminal.kitty() ? KITTY_ON : '') + BRACKETED_PASTE_ON)
	terminal.state.entered = true
}

// Restore the terminal for the shell. Leaves the screen content alone,
// with the cursor parked below it.
function leave(): void {
	let io = terminal.state.io
	if (!io || !terminal.state.entered) return
	terminal.state.entered = false
	try {
		terminal.park()
	} catch {}
	io.write((terminal.kitty() ? KITTY_OFF : '') + BRACKETED_PASTE_OFF + SHOW_CURSOR)
	io.setRawMode(false)
}

function quit(code = 0): void {
	try {
		terminal.onQuit()
	} catch {}
	terminal.leave()
	terminal.state.io!.exit(code)
}

function restart(): void {
	terminal.leave()
	terminal.state.io!.exit(terminal.restartCode)
}

function suspend(): void {
	terminal.state.suspended = true
	terminal.leave()
	terminal.state.io!.stop()
}

function resumed(): void {
	if (!terminal.state.suspended) return
	terminal.state.suspended = false
	terminal.enter()
	terminal.redraw()
}

// Only while we own the terminal; a resize during a suspend is answered
// by the redraw on resume.
function resized(): void {
	if (terminal.state.entered) terminal.onResize()
}

const ACTIONS: Record<EmergencyAction, () => void> = {
	quit: () => terminal.quit(),
	restart: () => terminal.restart(),
	suspend: () => terminal.suspend(),
}

// Decoded forms of the emergency keys, already handled from raw input.
function isEmergency(k: KeyEvent): boolean {
	return k.ctrl && !k.alt && !k.cmd && (k.key === 'c' || k.key === 'z' || k.key === 'r')
}

function onData(chunk: string | Uint8Array): void {
	let st = terminal.state
	for (let action of emergency.scan(st.emergency, chunk)) {
		ACTIONS[action]()
		// Only reached when exit is faked (tests): deliver nothing more.
		if (action !== 'suspend') return
	}
	if (st.escapeTimer) clearTimeout(st.escapeTimer)
	st.escapeTimer = null
	terminal.deliver(keys.feed(st.decoder, chunk))
	// A lone ESC may be Escape or the start of a sequence: wait briefly
	// for the rest before calling it Escape.
	if (keys.pending(st.decoder)) {
		st.escapeTimer = setTimeout(() => {
			st.escapeTimer = null
			terminal.deliver(keys.flush(st.decoder))
		}, terminal.escapeMs())
	}
}

function deliver(events: KeyEvent[]): void {
	events = events.filter((k) => !isEmergency(k))
	if (events.length) terminal.onKeys(events)
}

/** Take over the terminal. Idempotent; call only with a TTY. */
function init(io: TerminalIO = terminal.realIO()): void {
	if (terminal.state.io) return
	terminal.state.io = io
	// Safety net for exits that skip quit(): uncaught errors.
	io.onExit(() => terminal.leave())
	// Raw first: read in cooked mode, Bun loses a key typed at startup.
	terminal.enter()
	io.onData((chunk) => terminal.onData(chunk))
	io.onContinue(() => terminal.resumed())
	io.onResize(() => terminal.resized())
}

/** Forget the terminal (tests). Does not restore it. */
function reset(): void {
	if (terminal.state.escapeTimer) clearTimeout(terminal.state.escapeTimer)
	terminal.state = createState()
}

export const terminal = {
	state: createState(),
	/** ./run restarts Hal when it exits with this code. */
	restartCode: 100,
	/** Enable the kitty keyboard protocol; screen gets no query. */
	kitty: (): boolean => !ansi.mono(),
	/** How long a lone ESC waits for the rest of a sequence. */
	escapeMs: () => 50,
	/** Whether there is a terminal to take over; tests replace it. */
	available: (): boolean => !!process.stdin.isTTY,
	/** Receives decoded keys; replaced by the prompt. */
	onKeys: (_events: KeyEvent[]): void => {},
	/** Runs as the user quits, before the exit; set by main. Must be
	 * synchronous, quick and never throw or wait on the host. */
	onQuit: (): void => {},
	/** Repaints the screen after resume; replaced by the renderer. */
	redraw: (): void => {},
	/** Repaints after a terminal resize; replaced by the renderer. */
	onResize: (): void => {},
	/** Moves the cursor below the frame before the terminal is given
	 * back; replaced by the renderer. Must not throw or clear. */
	park: (): void => {},
	realIO,
	init,
	reset,
	enter,
	leave,
	onData,
	deliver,
	quit,
	restart,
	suspend,
	resumed,
	resized,
}
