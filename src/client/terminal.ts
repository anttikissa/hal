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

/** The process and tty operations the terminal needs; faked in tests. */
export interface TerminalIO {
	setRawMode(on: boolean): void
	onData(fn: (chunk: string | Uint8Array) => void): void
	write(s: string): void
	exit(code: number): void
	/** Stop this process like a shell job (SIGSTOP). */
	stop(): void
	onContinue(fn: () => void): void
	onExit(fn: () => void): void
}

interface TerminalState {
	io: TerminalIO | null
	decoder: DecoderState
	emergency: EmergencyState
	/** Raw mode and our terminal modes are on. */
	entered: boolean
	suspended: boolean
}

const BRACKETED_PASTE_ON = '\x1b[?2004h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'
// Kitty keyboard protocol: push "disambiguate escape codes", pop it.
const KITTY_ON = '\x1b[>1u'
const KITTY_OFF = '\x1b[<u'
const SHOW_CURSOR = '\x1b[?25h'

function createState(): TerminalState {
	return { io: null, decoder: keys.createState(), emergency: emergency.createState(), entered: false, suspended: false }
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
		onExit: (fn) => process.on('exit', fn),
	}
}

function enter(): void {
	let io = terminal.state.io!
	io.setRawMode(true)
	io.write((terminal.kitty() ? KITTY_ON : '') + BRACKETED_PASTE_ON)
	terminal.state.entered = true
}

// Restore the terminal for the shell. Leaves the screen content alone.
function leave(): void {
	let io = terminal.state.io
	if (!io || !terminal.state.entered) return
	terminal.state.entered = false
	io.write((terminal.kitty() ? KITTY_OFF : '') + BRACKETED_PASTE_OFF + SHOW_CURSOR)
	io.setRawMode(false)
}

function quit(): void {
	terminal.leave()
	terminal.state.io!.exit(0)
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
	let events = keys.feed(st.decoder, chunk).filter((k) => !isEmergency(k))
	if (events.length) terminal.onKeys(events)
}

/** Take over the terminal. Idempotent; call only with a TTY. */
function init(io: TerminalIO = terminal.realIO()): void {
	if (terminal.state.io) return
	terminal.state.io = io
	io.onData((chunk) => terminal.onData(chunk))
	io.onContinue(() => terminal.resumed())
	// Safety net for exits that skip quit(): uncaught errors, SIGTERM.
	io.onExit(() => terminal.leave())
	terminal.enter()
}

/** Forget the terminal (tests). Does not restore it. */
function reset(): void {
	terminal.state = createState()
}

export const terminal = {
	state: createState(),
	/** ./run restarts Hal when it exits with this code. */
	restartCode: 100,
	/** Enable the kitty keyboard protocol. */
	kitty: () => true,
	/** Receives decoded keys; replaced by the prompt. */
	onKeys: (_events: KeyEvent[]): void => {},
	/** Repaints the screen after resume; replaced by the renderer. */
	redraw: (): void => {},
	realIO,
	init,
	reset,
	enter,
	leave,
	onData,
	quit,
	restart,
	suspend,
	resumed,
}
