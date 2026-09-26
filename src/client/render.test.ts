import { afterEach, describe, expect, test } from 'bun:test'
import { strings } from '../common/strings.ts'
import type { Item, Transcript } from '../common/transcript.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'

// A small terminal emulator: a buffer of rows whose last `rows` rows are
// the screen and the rest scrollback. It understands exactly what a
// terminal would do with the sequences the renderer may use, including
// clamping cursor movement to the screen, and ignores styling.
class FakeTerminal {
	buffer: string[][] = []
	row = 0
	col = 0
	written = ''
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

const meta = { id: 's', cwd: '/', model: 'm', createdAt: '' }

function transcript(items: Item[]): Transcript {
	return { meta, items }
}

// n question/answer pairs.
function items(n: number, from = 0): Item[] {
	let out: Item[] = []
	for (let i = from; i < from + n; i++) out.push({ type: 'prompt', text: `q${i}` }, { type: 'text', text: `a${i}` })
	return out
}

let term: FakeTerminal
function setup(rows = 10, cols = 30, before: string[] = []) {
	term = new FakeTerminal(rows, cols, before)
	render.init(term)
	return term
}

function show(list: Item[], text = '', cursor = text.length, force = false) {
	render.state.view = { transcript: transcript(list), prompt: { text, cursor } }
	render.draw(force)
}

// What the renderer believes the whole frame is.
function frameText(): string[] {
	// What the fake terminal shows: styling dropped.
	return render.state.prev.map((l) => {
		let out = ''
		strings.walk(l, 0, (i, _w, len) => {
			out += l.slice(i, i + len)
		})
		return out.trimEnd()
	})
}

function cursorText(): string {
	return term.line().slice(term.col).join('').trimEnd()
}

afterEach(() => render.reset())

describe('grow mode', () => {
	test('starts at the cursor without clearing what the shell printed', () => {
		setup(10, 30, ['$ ls', 'a.txt b.txt'])
		show(items(1))
		expect(term.content()).toEqual(['$ ls', 'a.txt b.txt', ...frameText()])
		for (let seq of ['[2J', '[3J', '[H']) expect(term.written).not.toContain(seq)
	})

	test('updates in place while the frame fits: streaming, a longer and a shorter prompt', () => {
		setup(12, 30, ['$ hal'])
		show(items(1))
		for (let text of ['He', 'Hello', 'Hello, world, how are you doing today']) {
			show([...items(1), { type: 'prompt', text: 'q1' }, { type: 'text', text }])
			expect(term.content()).toEqual(['$ hal', ...frameText()])
		}
		show(items(2), 'a prompt long enough to wrap onto a second row')
		expect(term.content()).toEqual(['$ hal', ...frameText()])
		show(items(2), '')
		expect(term.content()).toEqual(['$ hal', ...frameText()])
		expect(render.state.fullscreen).toBe(false)
	})

	test('the terminal cursor is at the prompt cursor', () => {
		setup()
		show([], 'ab漢cd', 3)
		expect(cursorText()).toBe('cd')
		show([], 'ab漢cd', 2)
		expect(cursorText()).toBe('漢cd')
		show([], 'first\nsecond', 3)
		expect(cursorText()).toBe('st')
	})

	test('a forced repaint keeps the shell output above', () => {
		setup(10, 30, ['$ hal'])
		show(items(2), 'hi')
		show(items(2), 'hi', 2, true)
		expect(term.content()).toEqual(['$ hal', ...frameText()])
	})
})

describe('full mode', () => {
	test('a frame taller than the screen scrolls into scrollback with nothing lost or repeated', () => {
		setup(8, 30, ['$ hal'])
		for (let n = 1; n <= 12; n++) show(items(n))
		expect(render.state.fullscreen).toBe(true)
		// Growth only appended: shell output, then every frame row once.
		expect(term.content()).toEqual(['$ hal', ...frameText()])
		expect(term.screen()).toEqual(frameText().slice(-8))
	})

	test('is one-way: a frame that fits again stays in full mode', () => {
		setup(8, 30)
		show(items(6))
		show(items(1))
		expect(render.state.fullscreen).toBe(true)
	})

	test('a change in scrollback repaints canonically, with every history row', () => {
		setup(8, 30, ['$ hal'])
		show(items(10))
		let list = items(10)
		list[0] = { type: 'prompt', text: 'q0 edited' }
		show(list)
		expect(term.content()).toEqual(frameText())
		expect(frameText()).toContain(' > q0 edited')
		expect(frameText()).toContain(' a9')
	})

	test('a shrinking frame repaints canonically instead of duplicating rows', () => {
		setup(8, 30)
		show(items(10), 'two\nrows')
		show(items(10), 'one')
		expect(term.content()).toEqual(frameText())
	})

	test('after a shrink, any later change still lands on the right row', () => {
		// A shrink cannot pull scrollback back onto the screen; a renderer
		// that shrank in place would misplace later edits near the top.
		for (let k = 0; k < 20; k++) {
			render.reset()
			setup(8, 30)
			show(items(10), 'three\nprompt\nrows')
			show(items(10), 'one')
			let list = items(10)
			list[k] = { type: 'text', text: 'edited' }
			show(list, 'one')
			expect(term.content()).toEqual(frameText())
		}
	})

	test('changes on the screen are written in place without clearing scrollback', () => {
		setup(8, 30, ['$ hal'])
		let list = [...items(10), { type: 'text', text: 'stream' } as Item]
		show(list)
		term.written = ''
		list[list.length - 1] = { type: 'text', text: 'streaming on' }
		show(list, 'typing')
		expect(term.written).not.toContain('\x1b[3J')
		expect(term.content()).toEqual(['$ hal', ...frameText()])
	})

	test('a forced repaint (resize) clears scrollback and writes the whole frame', () => {
		setup(8, 30, ['$ hal'])
		show(items(10))
		term.resize(6, 30)
		render.draw(true)
		expect(term.content()).toEqual(frameText())
		expect(frameText().length).toBeGreaterThan(20)
	})
})

describe('resize', () => {
	test('a terminal too short for our top enters full mode instead of leaving stale rows', () => {
		setup(10, 30, ['$ hal'])
		show(items(2), 'x')
		term.resize(4, 30)
		render.draw(true)
		expect(render.state.fullscreen).toBe(true)
		expect(term.content()).toEqual(frameText())
	})

	test('narrowing rewraps within the new width', () => {
		setup(20, 40)
		show([{ type: 'text', text: 'some words that need to wrap when narrow' }])
		term.resize(20, 12)
		render.draw(true)
		for (let line of term.content()) expect(strings.visLen(line)).toBeLessThanOrEqual(12)
	})
})

describe('leaving and coming back', () => {
	test('park leaves the last frame and puts the cursor on a new line below it', () => {
		setup(10, 30, ['$ hal'])
		show(items(2), 'draft', 2)
		let painted = frameText()
		term.written = ''
		render.park()
		expect(term.content()).toEqual(['$ hal', ...painted])
		expect(term.top + term.row).toBe(1 + painted.length)
		expect(term.col).toBe(0)
		for (let seq of ['[J', '[2J', '[3J', '[H']) expect(term.written).not.toContain(seq)
	})

	test('while parked nothing paints; the forced redraw on resume paints below', () => {
		setup(10, 30)
		show(items(1))
		let last = term.content()
		render.park()
		term.write('[1]+ Stopped\r\n$ fg\r\n')
		show(items(2))
		expect(term.content()).toEqual([...last, '[1]+ Stopped', '$ fg'])
		render.draw(true)
		expect(term.content()).toEqual([...last, '[1]+ Stopped', '$ fg', ...frameText()])
	})

	test('quit through the terminal parks below the frame', () => {
		setup(10, 30)
		let exits: number[] = []
		terminal.init({
			setRawMode() {},
			onData() {},
			write: (s) => term.write(s),
			exit: (code) => exits.push(code),
			stop() {},
			onContinue() {},
			onExit() {},
			size: () => term.size(),
			onResize() {},
		})
		render.state.out = null
		render.init()
		show(items(1), 'x')
		let frameRows = term.content()
		terminal.quit()
		expect(exits).toEqual([0])
		expect(term.content()).toEqual(frameRows)
		expect(term.row).toBe(frameRows.length)
		terminal.reset()
		Object.assign(terminal, { redraw: () => {}, onResize: () => {}, park: () => {} })
	})
})

describe('request', () => {
	test('paints at once, then at most once per frame time', async () => {
		setup()
		let writes = 0
		let write = term.write.bind(term)
		term.write = (s) => {
			writes++
			write(s)
		}
		render.frameMs = () => 5
		render.state.view = { transcript: transcript([]), prompt: { text: '', cursor: 0 } }
		for (let i = 0; i < 50; i++) {
			render.state.view = { transcript: transcript([{ type: 'text', text: `t${i}` }]), prompt: { text: '', cursor: 0 } }
			render.request()
		}
		expect(writes).toBe(1)
		await Bun.sleep(20)
		expect(writes).toBe(2)
		// The trailing paint shows the latest view.
		expect(term.content()).toContain(' t49')
		render.frameMs = () => 16
	})
})
