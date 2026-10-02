import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { titles } from '../common/titles.ts'
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

let originalNames: Record<string, string>
beforeEach(() => { originalNames = titles.names; titles.names = { 'anthropic/claude-opus-5-5': 'Opus 5.5' } })
afterEach(() => { titles.names = originalNames })

// Where text in `style`'s quieter colour starts (ansi.quiet).
const quietOn = (style: { fg?: Oklch; bg?: Oklch }) => ansi.sgr({ fg: oklch.quiet(style.fg!, style.bg ?? colors.screen()) })

// Visible text only: escape sequences removed.
function strip(s: string): string {
	let out = ''
	strings.walk(s, 0, (i, _w, len) => {
		out += s.slice(i, i + len)
	})
	return out
}

function view(items: Item[], text = '', cursor = text.length): View {
	let transcript: Transcript = { meta: { id: 's', cwd: '/', model: 'm', createdAt: '' }, state: { type: 'idle' }, inbox: [], items: items.map((item, i) => ({ ...item, key: `~${i}` })) }
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
	expect(lines).toContain('question 0')
	expect(lines).toContain('answer 0')
	expect(lines).toContain('answer 299')
	expect(lines.filter((l) => l.startsWith('answer')).length).toBe(300)
})

test('exactly one blank row before [paused], however many newlines the model streamed', () => {
	let items: Item[] = [
		{ type: 'text', text: 'rain\n\n\n  \n' },
		{ type: 'turn-end', status: 'paused' },
	]
	let lines = plain(frame.build(view(items), 40).lines)
	let at = lines.indexOf('[paused]')
	expect(lines.slice(at - 2, at + 1)).toEqual(['rain', '', '[paused]'])
})

test('the same items drawn again follow a new width and colour', () => {
	let v = view([{ type: 'text', text: 'one two three four five six' }])
	let wide = frame.build(v, 40).lines
	expect(frame.build(v, 40).lines).toEqual(wide)
	expect(plain(frame.build(v, 12).lines).slice(0, 5)).toEqual(['Hal', '', 'one two', 'three four', 'five six'])
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

test('a tool result of megabytes is glimpsed in its first rows, each shown line wrapped, the rest counted', () => {
	let long = 'w'.repeat(100)
	let output = [long, ...Array.from({ length: 200_000 }, (_, i) => `row ${i}`)].join('\n')
	let started = performance.now()
	let lines = plain(frame.build(view([{ type: 'tool-result', id: 't', output }]), 40).lines).filter((l) => /w|row|more/.test(l))
	expect(performance.now() - started).toBeLessThan(50)
	// 100 w's on 34 columns wrap to three rows: the first three shown.
	expect(lines.slice(0, 3).every((l) => /^◂? ?w+$/.test(l))).toBe(true)
	expect(lines.at(-1)).toBe('… 200000 more lines')
})

test('a frame reusing the last one equals a frame built from nothing, as items stream in and change', () => {
	let items: Item[] = [{ type: 'prompt', text: 'hi' }, { type: 'text', text: 'one' }]
	let v = view(items)
	let fresh = (w: View) => {
		let kept = frame.state.history
		frame.state.history = undefined
		let f = frame.build(w, 50, 20, true)
		frame.state.history = kept
		return f.lines
	}
	let steps: View[] = [v]
	let t = v.transcript!
	steps.push({ ...v, transcript: { ...t, items: [...t.items, { type: 'tool', id: 'c', name: 'bash', input: {}, key: '7' }] } })
	let t2 = steps[1]!.transcript!
	steps.push({ ...v, transcript: { ...t2, items: [...t2.items, { type: 'tool-result', id: 'c', output: 'done', key: '~9' }] } })
	// A changed item (a new object) in the middle.
	let t3 = steps[2]!.transcript!
	steps.push({ ...v, transcript: { ...t3, items: [t3.items[0]!, { ...t3.items[1]!, text: 'one, edited' } as (typeof t3.items)[number], ...t3.items.slice(2)] } })
	steps.push({ ...steps[3]!, prompt: { text: 'typing', cursor: 6 } })
	for (let w of steps) expect(frame.build(w, 50, 20, true).lines).toEqual(fresh(w))
	// Another width lays everything out again.
	let narrow = frame.build(steps[4]!, 30, 20, true).lines
	frame.state.history = undefined
	expect(narrow).toEqual(frame.build(steps[4]!, 30, 20, true).lines)
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
	expect(b.rows).toEqual(['ab漢cd'])
	expect(f.cursor.row).toBe(b.top + 1)
	// The cursor is right after "ab漢": its column is the width of the row up to there.
	let row = f.lines[b.top + 1]!
	expect(f.cursor.col).toBe(strings.visLen(row.slice(0, row.indexOf('cd'))))
})

test('prompt cursor follows newlines and wrapping', () => {
	let text = 'first\n' + 'x'.repeat(30)
	let f = frame.build(view([], text), 20)
	// Two logical lines; the second wraps; the cursor is at its very end.
	expect(boxOf(f).rows.join('').replace(/ /g, '')).toBe(text.replace('\n', ''))
	expect(f.cursor.row).toBe(boxOf(f).bottom - 1)
	let lastRow = f.lines[f.cursor.row]!
	expect(f.cursor.col).toBe(strip(lastRow).trimEnd().length)

	let start = frame.build(view([], text, 6), 20)
	expect(strip(start.lines[start.cursor.row]!).slice(start.cursor.col)).toMatch(/^x/)
})

test('a cursor after a full prompt row stays inside the terminal', () => {
	// 20 columns: 1 pad + 18 text + 1 pad.
	let f = frame.build(view([], 'y'.repeat(18)), 20)
	expect(boxOf(f).rows.length).toBe(1)
	expect(f.cursor).toEqual({ row: boxOf(f).top + 1, col: 19 })
})

test('a notice sits between the transcript and the prompt, wrapped and cleaned', () => {
	let v = view([{ type: 'text', text: 'answer' }], 'typed')
	v.notice = 'refused: a turn is already running\x1b[2J in this session'
	let f = frame.build(v, 20)
	let lines = plain(f.lines)
	let at = lines.findIndex((l) => l.startsWith('refused'))
	expect(at).toBeGreaterThan(lines.indexOf('answer'))
	expect(at).toBeLessThan(boxOf(f).top)
	expect(boxOf(f).rows).toEqual(['typed'])
	expect(lines.join(' ')).toContain('in this session')
	for (let line of f.lines) {
		expect(strings.visLen(line)).toBeLessThanOrEqual(20)
		expect(strip(line)).not.toContain('\x1b')
	}
	expect(f.cursor.row).toBe(boxOf(f).top + 1)
})

// Truecolor SGR parameters for a colour, as the terminal gets them.
const rowWith = (lines: string[], text: string) => lines.find((l) => strip(l).includes(text))!

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

	test('an empty prompt shows a readable example distinguishable from typed text', () => {
		let f = frame.build({ prompt: { text: '', cursor: 0 }, placeholder: 'Try this' }, 40)
		expect(boxOf(f).rows).toEqual(['Try this'])
		let rgb = /38;2;(\d+);(\d+);(\d+)mTry this/.exec(f.lines[1]!)!.slice(1).map(Number)
		let fg = oklch.toRgb(colors.input().fg!), bg = oklch.toRgb(colors.input().bg!)
		// It stands out from the dark box, but recedes behind typed text.
		let dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]!))
		expect(dist(rgb, bg)).toBeGreaterThan(100)
		expect(dist(rgb, bg)).toBeLessThan(dist(fg, bg) * 0.7)
		expect(f.cursor).toEqual({ row: 1, col: 1 })
		let typed = frame.build({ prompt: { text: 'x', cursor: 1 }, placeholder: 'Try this' }, 40)
		expect(boxOf(typed).rows).toEqual(['x'])
		expect(typed.cursor).toEqual({ row: 1, col: 2 })
	})

	test('tabs are drawn as spaces to the next stop', () => {
		let f = frame.build({ prompt: { text: 'ab\tc', cursor: 3 } }, 40)
		expect(f.lines[1]).not.toContain('\t')
		expect(boxOf(f).rows).toEqual(['ab  c'])
		expect(f.cursor.col).toBe(1 + 4)
	})

	test('the selection shows in reverse video, a selected tab as spaces to its stop', () => {
		let row = (st: PromptState, cols = 40) => promptView.box(st, cols).rows
		expect(row({ text: 'a\tb', cursor: 2, anchor: 1 })).toEqual(['a\x1b[7m   \x1b[27mb'])
		expect(row({ text: '\tone\n\ttwo\nthree', cursor: 8, anchor: 0 })).toEqual(['\x1b[7m    one\x1b[27m', '\x1b[7m    tw\x1b[27mo', 'three'])
		// Across a wrapped row, and ending inside the box's width.
		let wrapped = row({ text: 'abcdef', cursor: 0, anchor: 6 }, 3)
		expect(wrapped).toEqual(['\x1b[7mabc\x1b[27m', '\x1b[7mdef\x1b[27m'])
		expect(row({ text: 'abc', cursor: 1, anchor: 1 })).toEqual(['abc'])
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
	let url = `http://localhost:${settings.webPort()}/image/abc123.png`
	let link = `\x1b]8;;${url}\x07[image/abc123.png]\x1b]8;;\x07`
	let f = frame.build(view([{ type: 'prompt', text: 'see [image/abc123.png] ok' }], 'and [image/abc123.png]'), 60)
	let rows = f.lines.filter((l) => l.includes('[image/abc123.png]'))
	expect(rows).toHaveLength(2)
	for (let row of rows) expect(row).toContain(link)
	expect(plain(rows)).toEqual(['see [image/abc123.png] ok', 'and [image/abc123.png]'])
	// A forged name is not linked.
	expect(frame.build(view([{ type: 'prompt', text: '[image/../x.png]' }]), 60).lines.join('')).not.toMatch(/\x1b\]8;;[^\x07]*x\.png/)
})

// OSC 8 targets in `lines`, in order.
function targets(lines: string[]): string[] {
	return lines.flatMap((l) => [...l.matchAll(/\x1b\]8;;([^\x07]+)\x07/g)].map((m) => m[1]!))
}

test('every block shows its id at the right of its first row, linked to the block on the web with the code hidden; a tool result and an item without a block id show none', () => {
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
		expect(blocks).toEqual(['4', '5', '6', '7', '8'].map((key) => ({ session: 's', key })))
		// The id is the link's text, at the right edge of the row.
		for (let key of ['4', '5', '6', '7', '8']) expect(plain(lines).some((l) => l.endsWith(` #${key}`) && l.length === 58)).toBe(true)
		expect(plain(lines)).not.toContain('#6.1')
		for (let u of links) expect(u.searchParams.get('auth')).toBe('k3x9qa')
		let shown = lines.map((l) => l.replace(/\x1b\]8;;[^\x07]*\x07/g, ''))
		expect(shown.join('\n')).not.toContain('k3x9qa')
		expect(plain(lines).join('\n')).toContain('bash {"command":"ls"}')
		expect(plain(lines).join('\n')).toContain('error: boom')
		// A streaming block's Hal cursor follows its text, not its id.
		let stream = view([{ type: 'text', text: 'Hel' }])
		stream.transcript!.items[0]!.key = '9'
		stream.hal = { at: 'stream', lit: true, color: colors.assistant().fg! }
		let streamed = plain(frame.build(stream, 60).lines)
		expect(streamed[0]).toMatch(/^Hal +#9$/)
		expect(streamed[2]).toBe('Hel█')
		// A block still streaming before it has a number is not linked.
		let streaming = view([{ type: 'tool', id: 't2', name: 'bash', input: {} }])
		streaming.transcript!.items[0]!.key = '~0'
		expect(targets(frame.build(streaming, 60).lines)).toEqual([])
	} finally {
		ansi.state.web = { url: '', code: '' }
	}
})

test('a [paste/<name>] marker links to its page; while its upload is in flight it is quieter and no link, with the same text', () => {
	let marker = uploads.begin('s', 'c.1', 'text/plain')
	let path = marker.slice(1, -1)
	let build = () => frame.build(view([], `see ${marker}`), 60).lines.filter((l) => l.includes(marker))
	try {
		let flying = build()
		expect(flying.join('')).not.toContain('\x1b]8;')
		expect(flying.join('')).toContain(quietOn(colors.user()) + marker)
		uploads.settle({ type: 'attached', sessionId: 's', command: 'c.1', blob: 'b', marker })
		let landed = build()
		expect(landed.join('')).toContain(`\x1b]8;;http://localhost:${settings.webPort()}/${path}\x07${marker}\x1b]8;;\x07`)
		expect(plain(landed)).toEqual(plain(flying))
	} finally {
		uploads.reset()
	}
})


test('a narrow terminal clips the header and keeps the block id', () => {
	let item: Item = { type: 'thinking', text: 'x', model: 'anthropic/claude-opus-5-5', effort: 'high', ts: new Date(2026, 8, 28, 10, 51).toISOString() }
	let v = view([item])
	v.transcript!.items[0]!.key = '35'
	let lines = plain(frame.build(v, 24).lines)
	expect(lines[0]).toMatch(/^10:51 Hal \(Opus 5.* #35$/)
	expect(lines[0]).not.toContain('high')
	expect(strings.visLen(frame.build(v, 24).lines[0]!)).toBeLessThanOrEqual(24)
})

test('tool timestamps and command-output headers match ordinary message time and spacing', () => {
	let ts = new Date(2026, 9, 2, 8, 50).toISOString()
	let f = frame.build(view([
		{ type: 'text', text: 'Message body', ts },
		{ type: 'tool', id: 'run', name: 'bash', input: { description: 'Inspect files', command: 'ls' }, ts },
		{ type: 'tool', id: 'read', name: 'read', input: { path: 'example.txt' }, ts },
		{ type: 'output', text: 'Command body', ts },
	]), 80)
	let lines = plain(f.lines)
	let ordinary = lines.findIndex(line => line.startsWith('08:50 Hal'))
	let output = lines.findIndex(line => line === '08:50')
	expect(lines[ordinary + 1]).toBe('')
	expect(lines[ordinary + 2]).toBe('Message body')
	expect(lines[output + 1]).toBe('')
	expect(lines[output + 2]).toBe('Command body')
	expect(lines.some(line => line.startsWith('08:50 Inspect files'))).toBe(true)
	expect(lines.some(line => line.startsWith('08:50 read '))).toBe(true)
})

test('finished thinking with no readable text draws nothing, not a bare header', () => {
	let lines = plain(frame.build(view([{ type: 'thinking', text: '', model: 'anthropic/claude-opus-5-5' }, { type: 'text', text: 'hi' }]), 60).lines)
	expect(lines.join('\n')).not.toContain('thinking')
	expect(lines.join('\n')).toContain('hi')
})


test('Bash results link to the call, hide a successful exit, and colour only a failed status', () => {
	let v = view([
		{ type: 'tool', id: 'run', name: 'bash', input: { description: 'Check files', command: 'git status --short' } },
		{ type: 'tool-result', id: 'run', output: '[exit 0]\n M notes.md\n' },
		{ type: 'tool-result', id: 'run', output: '[exit 123]\nerror: cannot access file\n' },
		{ type: 'prompt', text: '[exit 123]\nmissing file\n', from: 's', label: 'bash #1813' },
	])
	v.transcript!.items = v.transcript!.items.map((item, i) => ({ ...item, key: ['1813', '1814', '1815', '1816'][i]! }))
	let lines = frame.build(v, 70).lines
	let printed = plain(lines).join('\n')
	expect(printed).not.toContain('[exit 0]')
	// Under its call, a result needs no link back to it; apart, it has one.
	expect(printed).toContain('◂  M notes.md')
	expect(printed).toContain('◂ [exit 123]')
	expect(printed).not.toContain('#1813>')
	let apart = view([v.transcript!.items[0]!, { type: 'text', text: 'meanwhile' }, v.transcript!.items[1]!])
	apart.transcript!.items = apart.transcript!.items.map((item, i) => ({ ...item, key: ['1813', '1817', '1814'][i]! }))
	expect(plain(frame.build(apart, 70).lines).join('\n')).toContain('◂ #1813>  M notes.md')
	expect(targets(frame.build(apart, 70).lines)).toContain(`${settings.webUrl()}/s#1813`)
	let failure = lines.find((line) => line.includes('[exit 123]'))!
	let errorColor = ansi.sgr({ fg: colors.error().fg! })
	expect(failure).toContain(errorColor + '[exit 123]')
	expect(failure.slice(failure.indexOf('[exit 123]') + 10)).not.toContain(errorColor)
	expect(printed).toContain('Message from bash #1813')
})

test('legacy rename controls never appear in terminal answers without a naming flag', () => {
	let f = frame.build(view([{ type: 'text', text: 'Done.\n<rename>Fix replay persistence</rename>\n<summary>Fixed</summary>' }]), 80)
	let text = plain(f.lines).join('\n')
	expect(text).toContain('Done.')
	expect(text).not.toContain('Fix replay persistence')
	expect(text).not.toContain('<rename>')
})

