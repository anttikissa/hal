// Terminal key decoding: raw stdin bytes in, KeyEvents out.
//
// Incremental: a chunk may end inside a UTF-8 character, an escape
// sequence or a bracketed paste; the tail waits in the decoder state for
// the next chunk. A trailing lone ESC is ambiguous (Escape key or the
// start of a sequence), so it waits too — the caller calls flush() after
// a short idle to turn it into Escape.
//
// Unsupported sequences (unknown CSI, mouse, OSC/DCS replies, F-keys...)
// are dropped whole; escape bytes never leak out as text.
//
// Lifted from the old Hal keys.ts; this version adds chunk buffering,
// SS3 arrows, string-sequence skipping and code-point-safe text.

export interface KeyEvent {
	/** 'a', 'enter', 'backspace', 'left', 'escape', 'tab', 'paste', ... */
	key: string
	/** Text to insert: the typed character, or the whole paste. */
	text?: string
	shift: boolean
	alt: boolean
	ctrl: boolean
	/** Super/Command, only reported by the kitty protocol. */
	cmd: boolean
}

export interface DecoderState {
	utf8: TextDecoder
	/** Undecoded tail: an unfinished escape sequence. */
	pending: string
	/** Pasted text so far while inside ESC[200~ ... ESC[201~, else null. */
	paste: string | null
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

function createState(): DecoderState {
	return { utf8: new TextDecoder(), pending: '', paste: null }
}

function ke(key: string, mods?: Partial<KeyEvent>): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}

// CSI modifier parameter = 1 + bitmask (shift, alt, ctrl, super).
function parseMods(raw: number): Pick<KeyEvent, 'shift' | 'alt' | 'ctrl' | 'cmd'> {
	let m = Math.max(0, raw - 1)
	return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0, cmd: (m & 8) !== 0 }
}

const FINAL_KEYS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }
const TILDE_KEYS: Record<number, string> = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown' }

// Legacy control bytes. 0x0A is absent: raw-mode Enter sends CR, so a bare
// LF is Ctrl-J or a terminal's shift+enter mapping; see controlKey().
const CTRL_KEYS: Record<number, string> = {
	0: 'space', 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e', 6: 'f', 7: 'g', 8: 'backspace', 9: 'tab',
	11: 'k', 12: 'l', 13: 'enter', 14: 'n', 15: 'o', 16: 'p', 17: 'q', 18: 'r', 19: 's', 20: 't',
	21: 'u', 22: 'v', 23: 'w', 24: 'x', 25: 'y', 26: 'z', 27: 'escape', 31: '/', 127: 'backspace',
}
const PLAIN = new Set(['tab', 'enter', 'backspace', 'escape'])

function controlKey(code: number, alt = false): KeyEvent | null {
	if (code === 0x0a) return ke('enter', { shift: true, alt })
	let name = CTRL_KEYS[code]
	if (!name) return null
	return ke(name, { alt, ctrl: !PLAIN.has(name) })
}

// Mod field "mods[:eventType]"; event type 3 is a kitty key release.
function modField(field: string | undefined): Pick<KeyEvent, 'shift' | 'alt' | 'ctrl' | 'cmd'> | null {
	let [raw, type] = (field ?? '').split(':', 2)
	if (type === '3') return null
	let n = Number(raw || '1')
	return Number.isFinite(n) ? parseMods(n) : null
}

function parseCsi(body: string, final: string): KeyEvent | null {
	if (final === 'Z' && body === '') return ke('tab', { shift: true })
	if (final === 'u') return parseCsiU(body)
	let parts = body.split(';')
	let name = final === '~' ? TILDE_KEYS[Number(parts[0])] : FINAL_KEYS[final]
	if (!name || (final !== '~' && body !== '' && parts[0] !== '1')) return null
	let mods = modField(parts[1])
	return mods && ke(name, mods)
}

// Kitty CSI u: codepoint[:alternates];mods[:event];text-codepoints
function parseCsiU(body: string): KeyEvent | null {
	let fields = body.split(';')
	let cp = Number((fields[0] ?? '').split(':', 1)[0])
	if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return null
	let mods = modField(fields[1])
	if (!mods) return null
	if (cp === 13) return ke('enter', mods)
	if (cp === 9) return ke('tab', mods)
	if (cp === 27) return ke('escape', mods)
	if (cp === 127 || cp === 8) return ke('backspace', mods)
	// Private use area: kitty's codes for modifier keys, F-keys, keypad.
	if (cp >= 0xe000 && cp <= 0xf8ff) return null
	if (cp < 0x20) return null
	let text: string | undefined
	let cps = fields[2]?.split(':').map(Number)
	if (cps?.length && cps.every((n) => Number.isInteger(n) && n > 0 && n <= 0x10ffff)) text = String.fromCodePoint(...cps)
	let ch = text ?? String.fromCodePoint(cp)
	let typed = !mods.ctrl && !mods.cmd && !mods.alt
	return ke(ch.toLowerCase(), { ...mods, text: typed ? ch : undefined })
}

function printable(ch: string, alt = false): KeyEvent {
	return ke(ch.toLowerCase(), alt ? { alt } : { text: ch })
}

type Scan = { end: number; event: KeyEvent | null } | 'incomplete'

// CSI: params 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e.
// A byte outside those ranges ends a malformed sequence, which is dropped
// and scanning resumes at that byte.
function scanCsi(s: string, start: number, alt: boolean): Scan {
	let j = start
	while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++
	let paramEnd = j
	while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++
	if (j >= s.length) return 'incomplete'
	let c = s.charCodeAt(j)
	if (c < 0x40 || c > 0x7e) return { end: j, event: null }
	let event = j === paramEnd ? parseCsi(s.slice(start, paramEnd), s[j]!) : null
	if (event && alt) event.alt = true
	return { end: j + 1, event }
}

// OSC/DCS/APC/PM/SOS strings end with BEL or ST (ESC \).
function scanString(s: string, start: number): Scan {
	for (let j = start; j < s.length; j++) {
		if (s[j] === '\x07') return { end: j + 1, event: null }
		if (s[j] === '\x1b') {
			if (j + 1 >= s.length) return 'incomplete'
			if (s[j + 1] === '\\') return { end: j + 2, event: null }
		}
	}
	return 'incomplete'
}

// Decode one key starting at s[i] (an ESC).
function scanEscape(s: string, i: number): Scan {
	if (i + 1 >= s.length) return 'incomplete'
	let c = s[i + 1]!
	if (c === '[') return scanCsi(s, i + 2, false)
	if (c === 'O') {
		if (i + 2 >= s.length) return 'incomplete'
		let name = FINAL_KEYS[s[i + 2]!]
		return { end: i + 3, event: name ? ke(name) : null }
	}
	if (c === ']' || c === 'P' || c === '_' || c === '^' || c === 'X') return scanString(s, i + 2)
	if (c === '\x1b') {
		// ESC ESC [ ...: Alt+arrow in some terminals; otherwise Alt-Escape.
		if (i + 2 >= s.length) return 'incomplete'
		if (s[i + 2] === '[') return scanCsi(s, i + 3, true)
		return { end: i + 2, event: ke('escape', { alt: true }) }
	}
	let cp = s.codePointAt(i + 1)!
	let len = cp > 0xffff ? 2 : 1
	let event = cp < 0x20 || cp === 0x7f ? controlKey(cp, true) : c === 'b' ? ke('left', { alt: true }) : c === 'f' ? ke('right', { alt: true }) : printable(String.fromCodePoint(cp), true)
	return { end: i + 1 + len, event }
}

function endPaste(text: string): KeyEvent | null {
	text = text.replace(/\r\n?/g, '\n')
	return text ? ke('paste', { text }) : null
}

function feed(st: DecoderState, chunk: string | Uint8Array): KeyEvent[] {
	let data = typeof chunk === 'string' ? chunk : st.utf8.decode(chunk, { stream: true })
	let out: KeyEvent[] = []
	let s = st.pending + data
	st.pending = ''
	let i = 0
	while (i < s.length) {
		if (st.paste !== null) {
			// Search only where a new end marker could start.
			let from = Math.max(0, st.paste.length - PASTE_END.length + 1)
			st.paste += s.slice(i)
			i = s.length
			let end = st.paste.indexOf(PASTE_END, from)
			if (end < 0) break
			let rest = st.paste.slice(end + PASTE_END.length)
			let ev = endPaste(st.paste.slice(0, end))
			if (ev) out.push(ev)
			st.paste = null
			s = rest
			i = 0
			continue
		}
		if (s.startsWith(PASTE_START, i)) {
			st.paste = ''
			i += PASTE_START.length
			continue
		}
		if (s[i] === '\x1b') {
			// A paste start marker split across chunks is an incomplete CSI.
			let r = scanEscape(s, i)
			if (r === 'incomplete') {
				st.pending = s.slice(i)
				break
			}
			if (r.event) out.push(r.event)
			i = r.end
			continue
		}
		let cp = s.codePointAt(i)!
		let len = cp > 0xffff ? 2 : 1
		let ev = cp < 0x20 || cp === 0x7f ? controlKey(cp) : printable(String.fromCodePoint(cp))
		if (ev) out.push(ev)
		i += len
	}
	return out
}

/** Whether an unfinished escape sequence is waiting for more input. */
function pending(st: DecoderState): boolean {
	return st.pending !== ''
}

/** Resolve the waiting tail after an idle timeout: a lone ESC becomes
 * Escape, ESC ESC becomes Alt-Escape, anything else unfinished is
 * dropped. An unfinished paste keeps waiting for its end marker. */
function flush(st: DecoderState): KeyEvent[] {
	let p = st.pending
	st.pending = ''
	if (p === '\x1b') return [ke('escape')]
	if (p === '\x1b\x1b') return [ke('escape', { alt: true })]
	return []
}

export const keys = {
	state: createState(),
	createState,
	feed,
	flush,
	pending,
}
