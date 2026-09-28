import { describe, expect, test } from 'bun:test'
import { colors } from '../common/colors.ts'
import { modals } from '../common/modals.ts'
import { oklch, type Oklch } from '../common/oklch.ts'
import { strings } from '../common/strings.ts'
import type { Shown as Item, Transcript } from '../common/transcript.ts'
import { prompt, type PromptState } from '../common/prompt.ts'
import { settings } from '../common/settings.ts'
import { uploads } from '../common/uploads.ts'
import { frame, type Frame, type View } from './frame.ts'
import { promptView } from './prompt-view.ts'
import { ansi } from './ansi.ts'
import { target } from '../web/target.ts'

const DIM = '\x1b[2m'

// Visible text only: escape sequences removed.
function strip(s: string): string {
	let out = ''
	strings.walk(s, 0, (i, _w, len) => {
		out += s.slice(i, i + len)
	})
	return out
}

function view(items: Item[], text = '', cursor = text.length): View {
	let transcript: Transcript = { meta: { id: 's', cwd: '/', model: 'm', createdAt: '' }, state: { type: 'idle' }, inbox: [], items: items.map((item, i) => ({ ...item, key: `${i}` })) }
	return { transcript, prompt: { text, cursor } }
}

// The frame without escape sequences and trailing blanks.
function plain(lines: string[]): string[] {
	return lines.map((l) => strip(l).trim())
}

// The prompt box in a frame: the indices of its two rules and the
// plain rows between them.
function boxOf(f: Frame): { top: number; bottom: number; rows: string[] } {
	let lines = plain(f.lines)
	let rules = lines.flatMap((l, i) => (/^([↑↓]\d+ )?─/.test(l) ? [i] : []))
	let [top, bottom] = rules.slice(-2) as [number, number]
	return { top, bottom, rows: lines.slice(top + 1, bottom) }
}

test('shows every item, however long the history', () => {
	let items: Item[] = []
	for (let i = 0; i < 300; i++) items.push({ type: 'prompt', text: `question ${i}` }, { type: 'text', text: `answer ${i}` })
	let lines = plain(frame.build(view(items), 40).lines)
	expect(lines).toContain('> question 0')
	expect(lines).toContain('answer 0')
	expect(lines).toContain('answer 299')
	expect(lines.filter((l) => l.startsWith('answer')).length).toBe(300)
})

test('the same items drawn again follow a new width and colour', () => {
	let v = view([{ type: 'text', text: 'one two three four five six' }])
	let wide = frame.build(v, 40).lines
	expect(frame.build(v, 40).lines).toEqual(wide)
	expect(plain(frame.build(v, 12).lines).slice(0, 3)).toEqual(['one two', 'three four', 'five six'])
	let saved = colors.assistant
	try {
		colors.assistant = () => ({ fg: [0.5, 0.1, 30] })
		let fg = `38;2;${oklch.toRgb([0.5, 0.1, 30]).join(';')}`
		expect(frame.build(v, 40).lines[0]).toContain(fg)
	} finally {
		colors.assistant = saved
	}
})

test('no row is wider than the terminal, whatever the text', () => {
	let text = 'wide 漢字漢字漢字 and e\u0301 combining, 👨‍👩‍👧 emoji,\ttabs\tand a verylongwordthatcannotfitanywhere at all'
	let items: Item[] = [
		{ type: 'prompt', text },
		{ type: 'thinking', text },
		{ type: 'text', text },
		{ type: 'tool', id: 't', name: 'bash', input: { command: text } },
		{ type: 'tool', id: 't', name: 'bash', input: { command: text, description: text } },
		{ type: 'tool-result', id: 't', output: text },
		{ type: 'tool-result', id: 't', output: text, isError: true },
		{ type: 'turn-end', status: 'error', error: text },
	]
	for (let cols = 6; cols < 50; cols++) {
		let f = frame.build(view(items, text), cols)
		for (let line of f.lines) {
			expect(strings.visLen(line)).toBeLessThanOrEqual(cols)
			expect(line).not.toContain('\t')
		}
		expect(f.cursor.col).toBeLessThan(cols)
	}
})

test('a described command shows its description first and the command dimmed beside it', () => {
	let input = { command: "sed -n '1,40p' config.ason |\n  cat -n", description: 'Show the first 40 lines of the config' }
	let [line] = frame.build(view([{ type: 'tool', id: 't', name: 'bash', input }]), 100).lines
	let [before, after] = line!.split(DIM)
	expect(strip(before!)).toContain('Show the first 40 lines of the config')
	expect(strip(before!)).not.toContain('sed')
	expect(strip(after!)).toContain("sed -n '1,40p' config.ason | cat -n")
})

test('a long tool result shows only its first rows', () => {
	let output = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n')
	let lines = plain(frame.build(view([{ type: 'tool-result', id: 't', output }]), 40).lines)
	expect(lines.join('\n')).toContain('row 0')
	expect(lines.join('\n')).not.toContain('row 50')
	expect(lines.length).toBeLessThan(10)
})

test('text cannot send escape sequences to the terminal', () => {
	let f = frame.build(view([{ type: 'text', text: 'hi\x1b[2J\x1b]0;title\x07\r\nthere' }], 'a\x1bb'), 40)
	for (let line of f.lines) for (let c of ['\x07', '\r']) expect(line).not.toContain(c)
	// Only colour (SGR) sequences are left, which move nothing.
	for (let line of f.lines) for (let esc of line.split('\x1b').slice(1)) expect(esc).toMatch(/^\[[\d;]*m/)
	expect(plain(f.lines)).toContain('there')
})

test('the prompt is below the transcript and the cursor sits where the prompt cursor is', () => {
	let f = frame.build(view([{ type: 'text', text: 'hello' }], 'ab漢cd', 3), 40)
	let b = boxOf(f)
	expect(b.top).toBeGreaterThan(plain(f.lines).indexOf('hello'))
	expect(b.rows).toEqual(['> ab漢cd'])
	expect(f.cursor.row).toBe(b.top + 1)
	// The cursor is right after "ab漢": its column is the width of the row up to there.
	let row = f.lines[b.top + 1]!
	expect(f.cursor.col).toBe(strings.visLen(row.slice(0, row.indexOf('cd'))))
})

test('prompt cursor follows newlines and wrapping', () => {
	let text = 'first\n' + 'x'.repeat(30)
	let f = frame.build(view([], text), 20)
	// Two logical lines; the second wraps; the cursor is at its very end.
	expect(boxOf(f).rows.join('').replace(/[ >]/g, '')).toBe(text.replace('\n', ''))
	expect(f.cursor.row).toBe(boxOf(f).bottom - 1)
	let lastRow = f.lines[f.cursor.row]!
	expect(f.cursor.col).toBe(strip(lastRow).trimEnd().length)

	let start = frame.build(view([], text, 6), 20)
	expect(strip(start.lines[start.cursor.row]!).slice(start.cursor.col)).toMatch(/^x/)
})

test('a cursor after a full prompt row stays inside the terminal', () => {
	// 20 columns: 1 pad + "> " + 16 text + 1 pad.
	let f = frame.build(view([], 'y'.repeat(16)), 20)
	expect(boxOf(f).rows.length).toBe(1)
	expect(f.cursor).toEqual({ row: boxOf(f).top + 1, col: 19 })
})

test('an empty session is just the chrome: the prompt between its rules, then the help row', () => {
	let f = frame.build({ prompt: { text: '', cursor: 0 } }, 80)
	let b = boxOf(f)
	expect(b.top).toBe(0)
	expect(b.rows).toEqual(['>'])
	expect(f.lines.length).toBe(b.bottom + 2)
	expect(f.cursor).toEqual({ row: 1, col: 3 })
})

test('a notice sits between the transcript and the prompt, wrapped and cleaned', () => {
	let v = view([{ type: 'text', text: 'answer' }], 'typed')
	v.notice = 'refused: a turn is already running\x1b[2J in this session'
	let f = frame.build(v, 20)
	let lines = plain(f.lines)
	let at = lines.findIndex((l) => l.startsWith('refused'))
	expect(at).toBeGreaterThan(lines.indexOf('answer'))
	expect(at).toBeLessThan(boxOf(f).top)
	expect(boxOf(f).rows).toEqual(['> typed'])
	expect(lines.join(' ')).toContain('in this session')
	for (let line of f.lines) {
		expect(strings.visLen(line)).toBeLessThanOrEqual(20)
		expect(strip(line)).not.toContain('\x1b')
	}
	expect(f.cursor.row).toBe(boxOf(f).top + 1)
})

// Truecolor SGR parameters for a colour, as the terminal gets them.
const fgOf = (c: Oklch) => `38;2;${oklch.toRgb(c).join(';')}`
const bgOf = (c: Oklch) => `48;2;${oklch.toRgb(c).join(';')}`
const rowWith = (lines: string[], text: string) => lines.find((l) => strip(l).includes(text))!

test('items wear their theme colours', () => {
	let items: Item[] = [
		{ type: 'prompt', text: 'ask' },
		{ type: 'thinking', text: 'ponder' },
		{ type: 'text', text: 'reply' },
		{ type: 'tool', id: 't', name: 'bash', input: { command: 'ls' } },
		{ type: 'tool', id: 'u', name: 'mystery', input: {} },
		{ type: 'turn-end', status: 'error', error: 'boom' },
	]
	let lines = frame.build(view(items, 'typed'), 60).lines
	expect(rowWith(lines, 'ask')).toContain(fgOf(colors.user().fg!))
	expect(rowWith(lines, 'ponder')).toContain(fgOf(colors.thinking().fg!))
	expect(rowWith(lines, 'reply')).toContain(fgOf(colors.assistant().fg!))
	expect(rowWith(lines, 'ls')).toContain(bgOf(colors.toolBash().bg!))
	expect(rowWith(lines, 'mystery')).toContain(bgOf(colors.tool().bg!))
	expect(rowWith(lines, 'boom')).toContain(fgOf(colors.error().fg!))
	expect(rowWith(lines, 'typed')).toContain(bgOf(colors.input().bg!))
})

test('a card background fills the whole row and colour ends with the row', () => {
	let f = frame.build(view([{ type: 'prompt', text: 'short\nlines' }], 'typed'), 30)
	for (let text of ['short', 'lines', 'typed']) {
		let row = rowWith(f.lines, text)
		expect(strings.visLen(row)).toBe(30)
		expect(row.startsWith('\x1b[')).toBe(true)
		expect(row.endsWith('\x1b[39;49m')).toBe(true)
	}
	// The cursor still sits right after the typed text.
	let row = f.lines[f.cursor.row]!
	expect(f.cursor.col).toBe(strings.visLen(row.slice(0, row.indexOf('typed') + 5)))
})

test('the terminal follows a theme override at the next build', () => {
	let saved = colors.fgL
	try {
		colors.fgL = 0.95
		let row = rowWith(frame.build(view([{ type: 'text', text: 'reply' }]), 40).lines, 'reply')
		expect(row).toContain(fgOf([0.95, colors.fgC, 55]))
	} finally {
		colors.fgL = saved
	}
})

describe('prompt box', () => {
	let eight = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight'
	// The frame's text rows, as typed, and the row the cursor is on.
	let box = (f: Frame) => boxOf(f).rows.map((l) => l.replace(/^> /, ''))

	test('moving the cursor through the box and the frame agree', () => {
		// Word-wrapped rows: Up from the end lands where the frame draws above it.
		let text = 'the quick brown fox jumps over the lazy dog'
		let st = { text, cursor: text.length }
		for (let i = 0; i < 4; i++) {
			let f = frame.build({ prompt: st }, 20)
			let next = prompt.step(st, { key: 'up' }, frame.promptWidth(20)).state
			let g = frame.build({ prompt: next }, 20)
			if (f.cursor.row === boxOf(f).top + 1) break
			expect(g.cursor.row).toBe(f.cursor.row - 1)
			st = next
		}
	})

	test('shows at most the setting, scrolls with the cursor and says what it hides', () => {
		let long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
		let f = frame.build({ prompt: { text: long, cursor: long.length } }, 40)
		let rows = box(f)
		expect(rows.length).toBe(settings.promptRows())
		expect(plain(f.lines)[boxOf(f).top]).toMatch(/^↑20 ─/)
		expect(plain(f.lines)[boxOf(f).bottom]).toMatch(/^─+$/)
		expect(rows.at(-1)).toBe('line 29')
		expect(strip(f.lines[f.cursor.row]!)).toContain('line 29')
		let top = frame.build({ prompt: { text: long, cursor: 0 } }, 40)
		expect(box(top)[0]).toBe('line 0')
		expect(plain(top.lines)[boxOf(top).bottom]).toMatch(/^↓20 ─/)
		expect(top.promptScroll).toBe(0)
	})

	test('down keeps the viewport while the cursor stays in it', () => {
		let st: PromptState = { text: eight, cursor: 'one\ntwo\nthree\nfour\n'.length, rows: 3, scroll: 4 }
		let before = frame.build({ prompt: st }, 80)
		expect(box(before)[0]).toBe('five')
		let next = { ...prompt.step(st, { key: 'down' }, frame.promptWidth(80)).state, scroll: before.promptScroll }
		let after = frame.build({ prompt: next }, 80)
		expect(box(after)[0]).toBe('five')
		expect(after.cursor.row).toBe(before.cursor.row + 1)
	})

	test('Ctrl-= and Ctrl-- resize the box, never below what it needs', () => {
		let st: PromptState = { text: 'one\ntwo', cursor: 7 }
		let rows = (s: PromptState) => boxOf(frame.build({ prompt: s }, 80)).rows.length
		expect(rows(st)).toBe(2)
		let grown = prompt.step(st, { key: '=', ctrl: true }, frame.promptWidth(80)).state
		expect(rows(grown)).toBe(3)
		expect(rows(prompt.step(grown, { key: '-', ctrl: true }, frame.promptWidth(80)).state)).toBe(2)
		expect(rows(prompt.step(st, { key: '-', ctrl: true }, frame.promptWidth(80)).state)).toBe(2)
	})

	test('an empty prompt shows its placeholder dimmed, cursor at its start', () => {
		let f = frame.build({ prompt: { text: '', cursor: 0 }, placeholder: 'Try this' }, 40)
		expect(boxOf(f).rows).toEqual(['> Try this'])
		expect(f.lines[1]).toContain(DIM)
		expect(f.cursor).toEqual({ row: 1, col: 3 })
		let typed = frame.build({ prompt: { text: 'x', cursor: 1 }, placeholder: 'Try this' }, 40)
		expect(boxOf(typed).rows).toEqual(['> x'])
	})

	test('tabs are drawn as spaces to the next stop', () => {
		let f = frame.build({ prompt: { text: 'ab\tc', cursor: 3 } }, 40)
		expect(f.lines[1]).not.toContain('\t')
		expect(boxOf(f).rows).toEqual(['> ab  c'])
		expect(f.cursor.col).toBe(3 + 4)
	})

	test('the selection shows in reverse video, a selected tab as spaces to its stop', () => {
		let row = (st: PromptState, cols = 40) => promptView.box(st, cols).rows
		expect(row({ text: 'a\tb', cursor: 2, anchor: 1 })).toEqual(['> a\x1b[7m   \x1b[27mb'])
		expect(row({ text: '\tone\n\ttwo\nthree', cursor: 8, anchor: 0 })).toEqual(['> \x1b[7m    one\x1b[27m', '  \x1b[7m    tw\x1b[27mo', '  three'])
		// Across a wrapped row, and ending inside the box's width.
		let wrapped = row({ text: 'abcdef', cursor: 0, anchor: 6 }, 2 + 3)
		expect(wrapped).toEqual(['> \x1b[7mabc\x1b[27m', '  \x1b[7mdef\x1b[27m'])
		expect(row({ text: 'abc', cursor: 1, anchor: 1 })).toEqual(['> abc'])
	})
})

test('inside GNU screen the frame has no colour, only reverse video for the selection', () => {
	let env = process.env.STY
	process.env.STY = '1.pts-0.host'
	try {
		let v = view([{ type: 'prompt', text: 'hi' }, { type: 'text', text: 'hello' }, { type: 'output', text: 'boom', error: true }, { type: 'tool', id: 't', name: 'bash', input: { command: 'ls' } }], 'draft')
		v.tabs = { list: [{ id: 's', name: 's', cwd: '/', model: 'm', state: { type: 'running', phase: 'requesting' } }], focused: 's' }
		v.notice = 'note'
		let out = frame.build(v, 40).lines.join('\n')
		expect(strip(out)).toContain('hello')
		let modal = frame.build({ ...v, modal: modals.open({ title: 'Models', items: ['a', 'b'] }) }, 40).lines.join('\n')
		for (let s of [out, modal]) expect(s).not.toMatch(/\x1b\[[0-9;]*[34]8;/)
		expect(modal).toContain('\x1b[7m')
	} finally {
		if (env === undefined) delete process.env.STY
		else process.env.STY = env
	}
})

test('an [image/<name>] marker is a link to the image, in the transcript and the prompt; the text stays the same', () => {
	let url = `http://localhost:${settings.webPort()}/image/abc123`
	let link = `\x1b]8;;${url}\x07[image/abc123.png]\x1b]8;;\x07`
	let f = frame.build(view([{ type: 'prompt', text: 'see [image/abc123.png] ok' }], 'and [image/abc123.png]'), 60)
	let rows = f.lines.filter((l) => l.includes('[image/abc123.png]'))
	expect(rows).toHaveLength(2)
	for (let row of rows) expect(row).toContain(link)
	expect(plain(rows)).toEqual(['> see [image/abc123.png] ok', '> and [image/abc123.png]'])
	// A forged name is not linked.
	expect(frame.build(view([{ type: 'prompt', text: '[image/../x.png]' }]), 60).lines.join('')).not.toMatch(/\x1b\]8;;[^\x07]*x\.png/)
})

// OSC 8 targets in `lines`, in order.
function targets(lines: string[]): string[] {
	return lines.flatMap((l) => [...l.matchAll(/\x1b\]8;;([^\x07]+)\x07/g)].map((m) => m[1]!))
}

test('headers link to their block on the web, with the code hidden; items without a block id are not linked', () => {
	ansi.state.web = { url: 'https://h.example', code: 'k3x9qa' }
	try {
		let items: Item[] = [
			{ type: 'prompt', text: 'list files' },
			{ type: 'text', text: 'Looking.' },
			{ type: 'tool', id: 't1', name: 'bash', input: { command: 'ls' } },
			{ type: 'tool-result', id: 't1', output: 'a\nb' },
			{ type: 'question', id: 'q', form: { text: 'Delete?', fields: [] }, cancelled: true },
			{ type: 'turn-end', status: 'error', error: 'boom' },
		]
		let v = view(items)
		v.transcript!.items = v.transcript!.items.map((it, i) => ({ ...it, key: ['4', '5', '6', '6.1', '7', '8'][i]! }))
		let lines = frame.build(v, 60).lines
		let links = targets(lines).map((u) => new URL(u))
		// Each resolves on the web to the card of that block (task 0z).
		let blocks = links.map((u) => target.parse(u.href, u.pathname.slice(1)))
		expect(blocks).toEqual(['4', '6', '7', '8'].map((key) => ({ session: 's', key })))
		for (let u of links) expect(u.searchParams.get('auth')).toBe('k3x9qa')
		let shown = lines.map((l) => l.replace(/\x1b\]8;;[^\x07]*\x07/g, ''))
		expect(shown.join('\n')).not.toContain('k3x9qa')
		expect(plain(lines)).toContain('▸ bash {"command":"ls"}')
		expect(plain(lines)).toContain('error: boom')
		// A block still streaming before it has a number is not linked.
		let streaming = view([{ type: 'tool', id: 't2', name: 'bash', input: {} }])
		streaming.transcript!.items[0]!.key = '~0'
		expect(targets(frame.build(streaming, 60).lines)).toEqual([])
	} finally {
		ansi.state.web = { url: '', code: '' }
	}
})

test('a [paste/<name>] marker links to its page; while its upload is in flight it is dim and no link, with the same text', () => {
	let marker = uploads.begin('s', 'c.1', 'text/plain')
	let path = marker.slice(1, -1)
	let build = () => frame.build(view([], `see ${marker}`), 60).lines.filter((l) => l.includes(marker))
	try {
		let flying = build()
		expect(flying.join('')).not.toContain('\x1b]8;')
		expect(flying.join('')).toContain(`\x1b[2m${marker}`)
		uploads.settle({ type: 'attached', sessionId: 's', command: 'c.1', blob: 'b', marker })
		let landed = build()
		expect(landed.join('')).toContain(`\x1b]8;;http://localhost:${settings.webPort()}/${path.slice(0, path.lastIndexOf('.'))}\x07${marker}\x1b]8;;\x07`)
		expect(plain(landed)).toEqual(plain(flying))
	} finally {
		uploads.reset()
	}
})
