// Emergency keys: Ctrl-C quits, Ctrl-Z suspends, Ctrl-R restarts.
//
// Found in terminal raw stdin before any stateful decoding (keys.ts), so neither a
// half-read escape sequence nor an unfinished paste can swallow them. The
// legacy control bytes count wherever they appear — C0 controls are never
// part of UTF-8 multi-byte characters, and terminals execute them even
// inside escape sequences. The kitty CSI-u forms (ESC [ 99 ; 5 u) count
// too; the only state kept is the tail of a chunk that may be the start
// of one of those, so a form split across reads is still found.

export type EmergencyAction = 'quit' | 'suspend' | 'restart'

export interface EmergencyState {
	/** Chunk tail that may be the start of a CSI-u emergency key. */
	tail: string
}

const CODEPOINTS: Record<string, EmergencyAction> = { '99': 'quit', '122': 'suspend', '114': 'restart' }
const BYTES = Object.fromEntries(Object.entries(CODEPOINTS).map(([cp, action]) => [String.fromCharCode(Number(cp) - 96), action]))

// ESC [ code[:alternates] ; mods[:event] u
const CSI_U = /\x1b\[(\d+)(?::[\d:]*)?;(\d+)(?::(\d+))?u/y
// Could still become a CSI_U match with more input.
const PREFIX = /\x1b(?:\[[\d:;]*)?$/y
// Longer tails are not emergency keys; don't let junk grow the buffer.
const MAX_TAIL = 32

// Kitty modifiers are 1 + bitmask: shift 1, alt 2, ctrl 4, super 8,
// hyper 16, meta 32, caps lock 64, num lock 128. Ctrl must be the only
// command modifier; shift and the locks don't matter.
function ctrlOnly(raw: string): boolean {
	let m = Number(raw) - 1
	return (m & 4) !== 0 && (m & (2 | 8 | 16 | 32)) === 0
}

function createState(): EmergencyState {
	return { tail: '' }
}

// Bytes as one char each (latin1), so control bytes keep their value.
function toBinary(chunk: string | Uint8Array): string {
	if (typeof chunk === 'string') return chunk
	return new TextDecoder('latin1').decode(chunk)
}

/** Every emergency key in this chunk, in order. */
function scan(st: EmergencyState, chunk: string | Uint8Array): EmergencyAction[] {
	let s = st.tail + toBinary(chunk)
	st.tail = ''
	let out: EmergencyAction[] = []
	for (let i = 0; i < s.length; i++) {
		let byte = BYTES[s[i]!]
		if (byte) {
			out.push(byte)
			continue
		}
		if (s[i] !== '\x1b') continue
		CSI_U.lastIndex = i
		let m = CSI_U.exec(s)
		if (m) {
			let action = CODEPOINTS[m[1]!]
			let event = m[3] ?? '1'
			if (action && ctrlOnly(m[2]!) && event !== '3') out.push(action)
			i = CSI_U.lastIndex - 1
			continue
		}
		PREFIX.lastIndex = i
		if (s.length - i <= MAX_TAIL && PREFIX.test(s)) {
			st.tail = s.slice(i)
			break
		}
	}
	return out
}

// Both input adapters resolve and dispatch emergencies here, before UI state.
function action(k: { key: string; ctrl?: boolean; alt?: boolean; cmd?: boolean }): EmergencyAction | undefined {
	return k.key.length === 1 && k.ctrl && !k.alt && !k.cmd ? CODEPOINTS[String(k.key.toLowerCase().codePointAt(0))] : undefined
}

function handle(action: EmergencyAction | undefined, handlers: Partial<Record<EmergencyAction, () => void>>): boolean {
	let run = action && handlers[action]
	if (!run) return false
	run()
	return true
}

export const emergency = { createState, scan, action, handle }
