// Terminal input normalizer.
// Parses raw stdin bytes → structured KeyEvent regardless of terminal type.

export interface KeyEvent {
	key: string       // 'a', 'left', 'up', 'enter', 'backspace', 'tab', 'escape', etc.
	char?: string     // printable character to insert (may be multi-byte from paste)
	shift: boolean
	alt: boolean      // Option key on macOS
	ctrl: boolean
	cmd: boolean      // Super/Meta key; Command (⌘) on macOS
}

function ke(key: string, mods?: Partial<KeyEvent>): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}

// ── CSI modifier bits ──
// Raw modifier value = 1 + bitmask. Bits: 0=shift, 1=alt, 2=ctrl, 3=super(cmd)
function parseMods(raw: number): { shift: boolean; alt: boolean; ctrl: boolean; cmd: boolean } {
	const m = Math.max(0, raw - 1)
	return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0, cmd: (m & 8) !== 0 }
}

// ── CSI sequences: \x1b[...X ──

const CSI_SUFFIX_KEYS: Record<string, string> = {
	A: 'up', B: 'down', C: 'right', D: 'left',
	H: 'home', F: 'end',
}

const CSI_TILDE_KEYS: Record<number, string> = {
	1: 'home', 2: 'insert', 3: 'delete', 4: 'end',
	5: 'pageup', 6: 'pagedown',
}

function parseCsi(body: string, terminator: string): KeyEvent | null {
	// Modified keys: \x1b[1;MOD+suffix  e.g. \x1b[1;2D = shift+left
	// Kitty adds :eventType to modifier (1=press, 2=repeat, 3=release)
	const parts = body.split(';')
	const keyName = CSI_SUFFIX_KEYS[terminator]
	if (keyName) {
		const modField = parts[1] ?? ''
		const [rawModStr, eventTypeStr] = modField.split(':', 2)
		if (eventTypeStr === '3') return null // key release
		const mod = parts.length >= 2 ? Number(rawModStr || '1') : 1
		return ke(keyName, parseMods(mod))
	}
	// Tilde keys: \x1b[NUM~ or \x1b[NUM;MOD~
	if (terminator === '~') {
		const num = Number(parts[0])
		const name = CSI_TILDE_KEYS[num]
		if (!name) return null
		const modField = parts[1] ?? ''
		const [rawModStr, eventTypeStr] = modField.split(':', 2)
		if (eventTypeStr === '3') return null // key release
		const mod = parts.length >= 2 ? Number(rawModStr || '1') : 1
		return ke(name, parseMods(mod))
	}
	return null
}

// ── Kitty CSI u: \x1b[codepoint;modifier[;text]u ──

function parseCsiU(body: string): KeyEvent | null {
	const fields = body.split(';')
	const codepoint = Number((fields[0] || '').split(':', 1)[0])
	if (!Number.isFinite(codepoint)) return null

	const modPart = fields[1] ?? ''
	const [rawModStr, eventTypeStr] = modPart.split(':', 2)
	const rawMod = Number(rawModStr || '1')
	const eventType = Number(eventTypeStr || '1')
	if (!Number.isFinite(rawMod)) return null
	if (eventType === 3) return null // key-up, ignore

	const mods = parseMods(rawMod)

	// Text field (for printable keys)
	let text: string | undefined
	if (fields.length >= 3 && fields[2]) {
		const cps = fields[2].split(':').map(Number)
		if (cps.length > 0 && cps.every(n => Number.isFinite(n) && n > 0))
			text = String.fromCodePoint(...cps)
	}

	// Special codepoints
	if (codepoint === 13) return ke('enter', mods)
	if (codepoint === 9) return ke('tab', mods)
	if (codepoint === 27) return ke('escape', mods)
	if (codepoint === 127) return ke('backspace', mods)
	if (codepoint === 8) return ke('backspace', mods)

	// Super key itself — ignore
	if (codepoint === 0xffe3 || codepoint === 0xffe4) return null

	// Private-use area — ignore
	if (codepoint >= 0xe000 && codepoint <= 0xf8ff) return null

	// Ctrl+key: reconstruct the control character
	if (mods.ctrl && !mods.cmd && codepoint >= 0 && codepoint <= 0x7f) {
		const ch = String.fromCharCode(codepoint).toLowerCase()
		return ke(ch, mods)
	}

	// Printable
	const ch = text ?? (codepoint >= 0x20 ? String.fromCodePoint(codepoint) : undefined)
	const key = ch?.toLowerCase() ?? `u+${codepoint.toString(16)}`
	return ke(key, { ...mods, char: (!mods.ctrl && !mods.cmd) ? ch : undefined })
}

// ── Ctrl key mapping ──

const CTRL_KEYS: Record<number, string> = {
	0: 'space', 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e', 6: 'f', 7: 'g',
	8: 'backspace', 9: 'tab', 10: 'enter', 11: 'k', 12: 'l', 13: 'enter',
	14: 'n', 15: 'o', 16: 'p', 17: 'q', 18: 'r', 19: 's', 20: 't',
	21: 'u', 22: 'v', 23: 'w', 24: 'x', 25: 'y', 26: 'z', 27: 'escape',
	31: '/',
	127: 'backspace',
}

// ── Tokenizer: split raw stdin data into individual key sequences ──

const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~'

// Buffer for paste content that spans multiple data events
let pasteBuffer: string | null = null

function splitKeys(data: string): string[] {
	const keys: string[] = []
	let i = 0

	// If we're mid-paste from a previous chunk, accumulate
	if (pasteBuffer !== null) {
		const endIdx = data.indexOf(PASTE_END)
		if (endIdx >= 0) {
			const pasted = pasteBuffer + data.slice(0, endIdx)
			pasteBuffer = null
			if (pasted) keys.push(pasted)
			i = endIdx + PASTE_END.length
		} else {
			// Still no end delimiter — buffer everything
			pasteBuffer += data
			return keys
		}
	}

	while (i < data.length) {
		// Bracketed paste: extract content between delimiters as single token
		if (data.startsWith(PASTE_START, i)) {
			const contentStart = i + PASTE_START.length
			const endIdx = data.indexOf(PASTE_END, contentStart)
			if (endIdx >= 0) {
				const pasted = data.slice(contentStart, endIdx)
				if (pasted) keys.push(pasted)
				i = endIdx + PASTE_END.length
			} else {
				// Start buffering — end delimiter will come in a later chunk
				pasteBuffer = data.slice(contentStart)
				return keys
			}
			continue
		}
		if (data[i] === '\x1b') {
			if (i + 1 < data.length && (data[i + 1] === '[' || data[i + 1] === 'O')) {
				// CSI or SS3: scan parameter bytes (0x20-0x3f) then final byte
				let j = i + 2
				while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) j++
				if (j < data.length) j++ // final byte
				keys.push(data.slice(i, j)); i = j
			} else if (i + 2 < data.length && data[i + 1] === '\x1b' && (data[i + 2] === '[' || data[i + 2] === 'O')) {
				// Alt+arrow: ESC ESC [ X
				let j = i + 3
				while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) j++
				if (j < data.length) j++
				keys.push(data.slice(i, j)); i = j
			} else if (i + 1 < data.length) {
				keys.push(data.slice(i, i + 2)); i += 2
			} else {
				keys.push('\x1b'); i++
			}
		} else {
			keys.push(data[i]!); i++
		}
	}
	return keys
}

// ── Main entry point ──

export function parseKey(data: string): KeyEvent | null {
	// Empty
	if (!data) return null

	// CSI sequence: \x1b[...
	if (data.startsWith('\x1b[')) {
		const terminator = data[data.length - 1]!
		const body = data.slice(2, -1)
		// Kitty CSI u
		if (terminator === 'u') return parseCsiU(body)
		return parseCsi(body, terminator)
	}

	// Alt+key: \x1b followed by char
	if (data.length === 2 && data[0] === '\x1b') {
		const ch = data[1]!
		if (ch === '\r' || ch === '\n') return ke('enter', { alt: true })
		if (ch === '\x7f') return ke('backspace', { alt: true })
		if (ch === 'b') return ke('left', { alt: true })
		if (ch === 'f') return ke('right', { alt: true })
		if (ch >= ' ') return ke(ch.toLowerCase(), { alt: true })
		const code = ch.charCodeAt(0)
		const name = CTRL_KEYS[code]
		if (name) return ke(name, { alt: true, ctrl: true })
	}

	// Alt+arrow: \x1b\x1b[X (some terminals)
	if (data.length === 4 && data[0] === '\x1b' && data[1] === '\x1b' && data[2] === '[') {
		const arrow = CSI_SUFFIX_KEYS[data[3]!]
		if (arrow) return ke(arrow, { alt: true })
	}

	// Single escape
	if (data === '\x1b') return ke('escape')

	// Control characters
	if (data.length === 1) {
		const code = data.charCodeAt(0)
		if (code < 32 || code === 127) {
			const name = CTRL_KEYS[code]
			if (name) {
				// Tab, Enter, Backspace, Escape are their own keys (no ctrl flag)
				if (name === 'tab' || name === 'enter' || name === 'backspace' || name === 'escape')
					return ke(name)
				return ke(name, { ctrl: true })
			}
		}
		// Printable
		return ke(data.toLowerCase(), { char: data })
	}

	// Multi-byte paste or unicode
	if (!data.startsWith('\x1b')) return ke(data, { char: data })

	return null
}

/** Parse raw stdin data into key events (handles concatenated sequences). */
export function parseKeys(data: string): KeyEvent[] {
	const tokens = splitKeys(data)
	const events: KeyEvent[] = []
	for (const token of tokens) {
		const k = parseKey(token)
		if (k) events.push(k)
	}
	return events
}

export const keys = { parseKey, parseKeys }