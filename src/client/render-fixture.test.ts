// Shared fixtures for the renderer tests: a fake terminal that applies
// what the renderer writes, and helpers to show transcripts and read
// back the screen.

import { strings } from '../common/strings.ts'
import type { Shown as Item, Transcript } from '../common/transcript.ts'
import { render } from './render.ts'

// A small terminal emulator: a buffer of rows whose last `rows` rows are
// the screen and the rest scrollback. It understands exactly what a
// terminal would do with the sequences the renderer may use, including
// clamping cursor movement to the screen, and ignores styling.
export class FakeTerminal {
	buffer: string[][] = []
	row = 0
	col = 0
	written = ''
	// Buffer rows the terminal auto-wrapped out of: each continues on the
	// next, so selecting across them copies one line.
	soft = new Set<number>()
	constructor(
		public rows: number,
		public cols: number,
		before: string[] = [],
	) {
		for (let line of before) this.buffer.push([...line])
		this.row = before.length
		while (this.buffer.length < rows) this.buffer.push([])
		// The shell left the cursor on the line after its output.
		if (before.length >= rows) {
			this.buffer.push([])
			this.row = rows - 1
		}
	}
	get top(): number {
		return this.buffer.length - this.rows
	}
	line(): string[] {
		return this.buffer[this.top + this.row]!
	}
	lineFeed(): void {
		if (this.row === this.rows - 1) this.buffer.push([])
		else this.row++
	}
	write(s: string): void {
		this.written += s
		let i = 0
		while (i < s.length) {
			if (s[i] === '\x1b') {
				let end = strings.skipEscape(s, i)
				let seq = s.slice(i, end)
				i = end
				let m = /^.\[(\??)(\d*)([A-Za-z])$/.exec(seq)
				if (!m || m[1]) continue
				let n = m[2] ? Number(m[2]) : 0
				let line = this.line()
				switch (m[3]) {
					case 'A':
						this.row = Math.max(0, this.row - (n || 1))
						break
					case 'B':
						this.row = Math.min(this.rows - 1, this.row + (n || 1))
						break
					case 'G':
						this.col = Math.min(this.cols - 1, Math.max(0, (n || 1) - 1))
						break
					case 'H':
						this.row = this.col = 0
						break
					case 'K':
						if (n === 2) this.soft.delete(this.top + this.row)
						if (n === 2) line.length = 0
						else line.length = Math.min(line.length, this.col)
						break
					case 'J':
						if (n === 3) this.buffer.splice(0, this.top)
						else if (n === 2) for (let r = 0; r < this.rows; r++) this.buffer[this.top + r] = []
						else {
							line.length = Math.min(line.length, this.col)
							for (let r = this.row + 1; r < this.rows; r++) this.buffer[this.top + r] = []
						}
						break
					case 'm':
						break
					default:
						throw new Error(`unexpected sequence ${JSON.stringify(seq)}`)
				}
				continue
			}
			if (s[i] === '\r') {
				this.col = 0
				i++
				continue
			}
			if (s[i] === '\n') {
				this.lineFeed()
				i++
				continue
			}
			let g = strings.glyphAt(s, i, this.col)
			if (this.col + g.width > this.cols) {
				this.soft.add(this.top + this.row)
				this.col = 0
				this.lineFeed()
			}
			let line = this.line()
			while (line.length < this.col) line.push(' ')
			line[this.col] = s.slice(i, i + g.length)
			for (let k = 1; k < g.width; k++) line[this.col + k] = ''
			this.col += g.width
			i += g.length
		}
	}
	/** Every row in the terminal buffer, without trailing blank rows. */
	content(): string[] {
		let out = this.buffer.map((r) => r.join('').trimEnd())
		while (out.length && out.at(-1) === '') out.pop()
		return out
	}
	/** Lines as copied: rows the terminal soft-wrapped joined. */
	logical(): string[] {
		let out: string[] = []
		let joining = false
		this.buffer.forEach((r, i) => {
			let text = r.join('')
			if (joining) out[out.length - 1] += text
			else out.push(text)
			joining = this.soft.has(i)
		})
		return out.map((l) => l.trimEnd())
	}
	/** Rows on the screen. */
	screen(): string[] {
		return this.buffer.slice(this.top).map((r) => r.join('').trimEnd())
	}
	size() {
		return { rows: this.rows, cols: this.cols }
	}
	resize(rows: number, cols: number): void {
		// Keep the cursor's row in the buffer; grow or shrink the screen
		// from the top. (No reflow: frames never exceed the width.)
		let abs = this.top + this.row
		this.rows = rows
		this.cols = cols
		while (this.buffer.length < rows) this.buffer.push([])
		this.row = abs - this.top
		while (this.row >= rows) {
			this.buffer.push([])
			this.row--
		}
		if (this.row < 0) {
			this.buffer.splice(abs + 1)
			while (this.buffer.length < rows) this.buffer.push([])
			this.row = abs - this.top
		}
	}
}

export const meta = { id: 's', cwd: '/', model: 'm', createdAt: '' }

export function transcript(items: Item[]): Transcript {
	return { meta, state: { type: 'idle' }, inbox: [], items: items.map((item, i) => ({ ...item, key: `~${i}` })) }
}

// n question/answer pairs.
export function items(n: number, from = 0): Item[] {
	let out: Item[] = []
	// Items of two rows each, without headers (task hp): two outputs.
	for (let i = from; i < from + n; i++) out.push({ type: 'output', text: `q${i}` }, { type: 'output', text: `a${i}` })
	return out
}

export let term: FakeTerminal
export function setup(rows = 10, cols = 30, before: string[] = []) {
	term = new FakeTerminal(rows, cols, before)
	render.init(term)
	return term
}

export function show(list: Item[], text = '', cursor = text.length, force = false) {
	render.state.view = { transcript: transcript(list), prompt: { text, cursor } }
	render.draw(force)
}

// Rows as FakeTerminal.content shows them: no trailing blanks.
export function trimmed(rows: string[]): string[] {
	let out = rows.map((r) => r.trimEnd())
	while (out.at(-1) === '') out.pop()
	return out
}

// What the renderer believes the whole frame is.
export function frameText(): string[] {
	// What the fake terminal shows: styling dropped.
	return render.state.prev.map((l) => {
		let out = ''
		strings.walk(l, 0, (i, _w, len) => {
			out += l.slice(i, i + len)
		})
		return out.trimEnd()
	})
}

export function cursorText(): string {
	return term.line().slice(term.col).join('').trimEnd()
}
