import { afterEach, describe, expect, test } from 'bun:test'
import { colors } from '../common/colors.ts'
import { modals, type ModalState } from '../common/modals.ts'
import { strings } from '../common/strings.ts'
import type { Shown as Item, Transcript } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
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

const meta = { id: 's', cwd: '/', model: 'm', createdAt: '' }

function transcript(items: Item[]): Transcript {
	return { meta, state: { type: 'idle' }, inbox: [], items: items.map((item, i) => ({ ...item, key: `~${i}` })) }
}

// n question/answer pairs.
function items(n: number, from = 0): Item[] {
	let out: Item[] = []
	// Items of two rows each, without headers (task hp): two outputs.
	for (let i = from; i < from + n; i++) out.push({ type: 'output', text: `q${i}` }, { type: 'output', text: `a${i}` })
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

// Rows as FakeTerminal.content shows them: no trailing blanks.
function trimmed(rows: string[]): string[] {
	let out = rows.map((r) => r.trimEnd())
	while (out.at(-1) === '') out.pop()
	return out
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
		setup(20, 30, ['$ hal'])
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
		setup(14, 30, ['$ hal'])
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
		list[0] = { type: 'output', text: 'q0 edited' }
		show(list)
		expect(term.content()).toEqual(frameText())
		expect(frameText()).toContain(' q0 edited')
		expect(frameText()).toContain(' a9')
	})

	test('a shrink repaints canonically, and any later change still lands on the right row', () => {
		// A shrink cannot pull scrollback back onto the screen; a renderer
		// that shrank in place would misplace later edits near the top.
		for (let k = 0; k < 20; k++) {
			render.reset()
			setup(8, 30)
			show(items(10), 'three\nprompt\nrows')
			show(items(10), 'one')
			if (k === 0) expect(term.content()).toEqual(frameText())
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
	test('park leaves the last frame but its last row, where the cursor goes, without scrolling', () => {
		setup(10, 30, ['$ hal'])
		show(items(2), 'draft', 2)
		render.state.view.editing = 'hint'
		render.draw()
		let painted = frameText()
		expect(painted.at(-1)).toContain('hint')
		let top = term.top
		term.written = ''
		render.park()
		expect(term.content()).toEqual(trimmed(['$ hal', ...painted.slice(0, -1)]))
		expect(term.top).toBe(top)
		expect(term.top + term.row).toBe(painted.length)
		expect(term.col).toBe(0)
		for (let seq of ['[J', '[2J', '[3J', '[H']) expect(term.written).not.toContain(seq)
	})

	test('while parked nothing paints; the forced redraw on resume paints below', () => {
		setup(10, 30)
		show(items(1))
		let last = term.content().slice(0, -1)
		render.park()
		term.write('[1]+ Stopped\r\n$ fg\r\n')
		show(items(2))
		expect(term.content()).toEqual([...last, '[1]+ Stopped', '$ fg'])
		render.draw(true)
		expect(term.content()).toEqual([...last, '[1]+ Stopped', '$ fg', ...frameText()])
	})

	test('quit through the terminal parks on the last frame row', () => {
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
		let height = frameText().length
		terminal.quit()
		expect(exits).toEqual([0])
		expect(term.content()).toEqual(trimmed(frameRows.slice(0, -1)))
		expect(term.row).toBe(height - 1)
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
		render.frameMs = 5
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
		render.frameMs = 16
	})
})

describe('modals', () => {
	const search = { text: 'Models', fields: [{ type: 'text' as const, name: 'q', label: 'Search' }] }
	const names = Array.from({ length: 100 }, (_, i) => `model ${i}`)

	function withModal(modal: ModalState | undefined) {
		render.state.view = { transcript: transcript(items(30)), prompt: { text: '', cursor: 0 }, ...(modal ? { modal } : {}) }
		render.draw()
	}

	test('open, typed into and closed in place: scrollback untouched, the old screen back', () => {
		setup(20, 40)
		withModal(undefined)
		let before = term.content()
		let scrollback = before.slice(0, term.top)
		let written = term.written.length
		let m = modals.open({ title: 'Models', form: search, items: names })
		withModal(m)
		expect(term.screen().some((r) => r.includes('┌─ Models'))).toBe(true)
		for (let c of 'opus') {
			m = modals.step(m, { key: c, text: c }).state
			withModal(m)
			expect(term.content().slice(0, term.top)).toEqual(scrollback)
			// The cursor is where the frame says, in the search box.
			expect(term.line().join('').slice(0, term.col)).toEndWith(`Search: ${'opus'.slice(0, 'opus'.indexOf(c) + 1)}`)
		}
		withModal(undefined)
		expect(term.content()).toEqual(before)
		expect(term.written.slice(written)).not.toContain('[3J')
	})
})

describe('tabs', () => {
	const tab = (id: string) => ({ id, name: id, cwd: '/', model: 'm', state: { type: 'idle' as const } })
	const list = [tab('a'), tab('b'), tab('c')]
	function showTab(focused: string, history: Item[], text = '') {
		render.state.view = { transcript: transcript(history), prompt: { text, cursor: text.length }, tabs: { list, focused } }
		render.draw()
	}
	const promptRow = () => term.screen().findIndex((r) => r.includes('typed'))

	test('after switching, scrollback and screen hold exactly the focused tab', () => {
		setup(10, 30, ['$ hal'])
		let short = [{ type: 'text', text: 'short tab' } as Item]
		let long = items(100, 1000)
		showTab('a', short)
		showTab('b', long)
		expect(term.content()).toEqual(frameText())
		expect(frameText()).toContain(' a1000')
		expect(frameText()).toContain(' a1099')
		showTab('a', short)
		expect(term.content()).toEqual(frameText())
		expect(term.content().join('\n')).not.toContain('a10')
		showTab('b', long)
		expect(term.content()).toEqual(frameText())
	})

	test('in full mode the prompt is on the bottom rows, whatever the tab height', () => {
		// A restart on a short tab 3: the first paint already has it low.
		setup(20, 30, ['$ hal'])
		let bottom = () => term.screen().findLastIndex((r) => r.trim() !== '')
		showTab('c', items(1), 'typed')
		let row = promptRow()
		expect(row).toBeGreaterThan(10)
		expect(bottom()).toBe(19)
		for (let [id, n] of [['a', 3], ['b', 0], ['c', 30], ['a', 3]] as const) {
			showTab(id, items(n), 'typed')
			expect(promptRow()).toBe(row)
			expect(bottom()).toBe(19)
		}
		term.resize(14, 25)
		render.draw(true)
		expect(bottom()).toBe(13)
	})

	test('a single tab that fits keeps grow mode and never clears scrollback', () => {
		setup(20, 30, ['$ hal'])
		let one = [tab('a')]
		let showOne = (history: Item[], text = '') => {
			render.state.view = { transcript: transcript(history), prompt: { text, cursor: text.length }, tabs: { list: one, focused: 'a' } }
			render.draw()
		}
		for (let n = 0; n <= 3; n++) showOne(items(n), 'typed')
		term.resize(22, 30)
		render.draw(true)
		render.draw(true)
		showOne(items(2))
		expect(term.written).not.toContain('\x1b[3J')
		expect(term.content()).toEqual(['$ hal', ...frameText()])
	})

	test('with two or more tabs the first paint is full mode: what was on screen goes', () => {
		// A restart on tab 2: the last run's frame is still on screen.
		setup(10, 30, ['$ hal', 'old tab 1 row', 'old prompt'])
		showTab('b', items(1), 'typed')
		expect(render.state.fullscreen).toBe(true)
		expect(term.written).toContain('\x1b[3J')
		expect(term.content()).toEqual(frameText())
	})

	test('a tab switch, Ctrl-L redraw and resize are canonical repaints once in full mode', () => {
		setup(10, 30, ['$ hal'])
		showTab('a', items(1))
		showTab('b', items(2))
		for (let again of [() => render.draw(true), () => (term.resize(12, 30), render.draw(true))]) {
			term.written = ''
			again()
			expect(term.written).toContain('\x1b[3J')
			expect(term.content()).toEqual(frameText())
		}
	})
})

describe('long words', () => {
	let url = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&scope=org%3Acreate_api_key'

	test('a URL wider than the terminal is one soft-wrapped line: no pad or fill inside it', () => {
		setup(20, 30)
		show([{ type: 'output', text: `Open this: ${url} then paste` }])
		expect(term.content()).toEqual(frameText())
		expect(term.logical()).toContain(` ${url}`)
	})

	test('rows after it and changes inside it keep it whole and in place', () => {
		setup(20, 30)
		let list: Item[] = [{ type: 'output', text: 'before' }, { type: 'output', text: url }]
		show(list)
		show([...list, { type: 'output', text: 'after' }], 'typed')
		expect(term.logical()).toContain(` ${url}`)
		// The URL grows (it streams): its rows are rewritten in place.
		show([list[0]!, { type: 'output', text: `${url}&more=1` }, { type: 'output', text: 'after' }], 'typed')
		expect(term.content()).toEqual(frameText())
		expect(term.logical()).toContain(` ${url}&more=1`)
		expect(term.logical()).not.toContain(` ${url}`)
	})
})

describe('terminal.redraw', () => {
	test('is a no-op before the UI is ready and while suspended', () => {
		expect(() => terminal.redraw()).not.toThrow()
		setup()
		show(items(1))
		term.written = ''
		terminal.state.suspended = true
		terminal.redraw()
		terminal.state.suspended = false
		expect(term.written).toBe('')
	})

	test('repaints every row in the current colours, cached rows too', () => {
		setup(10, 40)
		// The exit status colour is painted inside the row, not part of
		// the item's own style.
		show([{ type: 'prompt', label: 'bash #1', text: '[exit 1] failed' }])
		let diff = colors.diff
		let red = ansi.sgr({ fg: colors.diff().removeFg! })
		let green = ansi.sgr({ fg: [0.8, 0.15, 145] })
		expect(term.written).toContain(red)
		try {
			colors.diff = () => ({ ...diff(), removeFg: [0.8, 0.15, 145] })
			term.written = ''
			terminal.redraw()
			expect(term.written).toContain(green)
			expect(term.written).not.toContain(red)
		} finally {
			colors.diff = diff
		}
	})
})

describe('a long history (task 7j)', () => {
	test('is laid out in slices: the prompt paints meanwhile, and the end is the frame built at once', async () => {
		let slice = render.sliceMs
		render.sliceMs = -1
		try {
			setup(8, 30)
			let list = items(40)
			render.state.view = { transcript: transcript(list), prompt: { text: '', cursor: 0 } }
			render.draw()
			expect(frameText()).toContain(' a39')
			expect(frameText()).not.toContain(' q0')
			render.state.view.prompt = { text: 'typed', cursor: 5 }
			render.draw()
			expect(term.screen().join('\n')).toContain('typed')
			while (render.state.slicing) await Bun.sleep(1)
			expect(term.content()).toEqual(frameText())
			let sliced = frameText()
			render.reset()
			setup(8, 30)
			render.sliceMs = slice
			show(list, 'typed')
			expect(frameText()).toEqual(sliced)
		} finally {
			render.sliceMs = slice
		}
	})
})
