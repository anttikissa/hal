// OSC 11 replies share stdin with keystrokes. Buffer only incomplete framing;
// never interpret bracketed paste as a terminal reply or guess a missing color.
import { terminalOutput } from './terminal-output.ts'

const OSC11 = '\x1b]11;'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const state = {
	background: null as [number, number, number] | null,
	queried: false,
	partial: '',
	pasting: false,
}

function query(): void {
	if (state.queried) return
	state.queried = true
	terminalOutput.write('\x1b]11;?\x1b\\')
}

function component(hex: string): number {
	return Math.round(parseInt(hex, 16) * 255 / (16 ** hex.length - 1))
}

function consume(data: string): string {
	let text = state.partial + data
	state.partial = ''
	let input = ''
	while (text) {
		if (state.pasting) {
			const end = text.indexOf(PASTE_END)
			if (end >= 0) {
				input += text.slice(0, end + PASTE_END.length)
				text = text.slice(end + PASTE_END.length)
				state.pasting = false
				continue
			}
			// Keep only a possible split closing delimiter, not the paste itself.
			for (let n = Math.min(text.length, PASTE_END.length - 1); n > 0; n--) {
				if (!text.endsWith(PASTE_END.slice(0, n))) continue
				state.partial = text.slice(-n)
				text = text.slice(0, -n)
				break
			}
			return input + text
		}
		if (text.startsWith(OSC11)) {
			const end = text.search(/\x07|\x1b\\/)
			if (end < 0) {
				// A broken reply must not grow a buffer without bound.
				if (text.length <= 128) state.partial = text
				return input
			}
			const match = text.slice(OSC11.length, end).match(/^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i)
			if (match) state.background = [component(match[1]!), component(match[2]!), component(match[3]!)]
			text = text.slice(end + (text[end] === '\x07' ? 1 : 2))
			continue
		}
		if (text.startsWith(PASTE_START)) {
			input += PASTE_START
			text = text.slice(PASTE_START.length)
			state.pasting = true
			continue
		}
		if (OSC11.startsWith(text) || PASTE_START.startsWith(text)) {
			state.partial = text
			return input
		}
		const next = text.indexOf('\x1b', 1)
		if (next < 0) return input + text
		input += text.slice(0, next)
		text = text.slice(next)
	}
	return input
}

// Escape needs a short ambiguity window; a started reply gets longer to arrive.
// A truncated reply is discarded on timeout rather than inserted into the prompt.
function flushDelay(): number {
	if (!state.partial || state.pasting) return 0
	return state.partial.startsWith('\x1b]') ? 1000 : 25
}

function flush(): string {
	if (state.pasting) return ''
	const input = state.partial
	state.partial = ''
	if (input.startsWith('\x1b]')) return ''
	return input
}

function reset(): void {
	Object.assign(state, { background: null, queried: false, partial: '', pasting: false })
}

export const terminalBackground = { state, query, consume, flush, flushDelay, reset }
