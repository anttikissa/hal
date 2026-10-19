// Frame tests for the prompt box, its cursor and the notice above it.

import { describe, expect, test } from 'bun:test'
import { colors } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
import { strings } from '../common/strings.ts'
import { prompt, type PromptState } from '../common/prompt.ts'
import { settings } from '../common/settings.ts'
import { frame, type Frame } from './frame.ts'
import { promptView } from './prompt-view.ts'
import { boxOf, plain, strip, view, useNames } from './frame-fixture.test.ts'

useNames()

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

// Truecolor SGR parameters for a color, as the terminal gets them.
const rowWith = (lines: string[], text: string) => lines.find((l) => strip(l).includes(text))!

test('a card background fills the whole row and color ends with the row', () => {
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

	test('hints the resize keys once the text nears the box height', () => {
		let help = (n: number, text = Array.from({ length: n }, (_, i) => `l${i}`).join('\n')) =>
			plain(frame.build({ prompt: { text, cursor: 0 } }, 80).lines).at(-1)!
		let near = settings.promptRows() - 2
		expect(help(near)).toContain('ctrl-=/-')
		expect(help(near - 1)).not.toContain('ctrl-=/-')
		expect(help(30)).toContain('ctrl-=/-')
		expect(help(30, '\n'.repeat(30))).not.toContain('ctrl-=/-')
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
		let f = frame.build(
			{ prompt: { text: '', cursor: 0 }, placeholder: { cut: '', text: 'Try this', next: Infinity } },
			40,
		)
		expect(boxOf(f).rows).toEqual(['Try this'])
		let rgb = /38;2;(\d+);(\d+);(\d+)mTry this/.exec(f.lines[2]!)!.slice(1).map(Number)
		let fg = oklch.toRgb(colors.input().fg!),
			bg = oklch.toRgb(colors.input().bg!)
		// It stands out from the dark box, but recedes behind typed text.
		let dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]!))
		expect(dist(rgb, bg)).toBeGreaterThan(100)
		expect(dist(rgb, bg)).toBeLessThan(dist(fg, bg) * 0.7)
		expect(f.cursor).toEqual({ row: 2, col: 1 })
		// Erasing from its left as typing starts: what is left keeps its columns.
		let typed = frame.build(
			{ prompt: { text: 'x', cursor: 1 }, placeholder: { cut: 'Tr', text: 'y this', fade: 'left', next: 5 } },
			40,
		)
		expect(boxOf(typed).rows).toEqual(['x y this'])
		expect(typed.cursor).toEqual({ row: 2, col: 2 })
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
		expect(row({ text: '\tone\n\ttwo\nthree', cursor: 8, anchor: 0 })).toEqual([
			'\x1b[7m    one\x1b[27m',
			'\x1b[7m    tw\x1b[27mo',
			'three',
		])
		// Across a wrapped row, and ending inside the box's width.
		let wrapped = row({ text: 'abcdef', cursor: 0, anchor: 6 }, 3)
		expect(wrapped).toEqual(['\x1b[7mabc\x1b[27m', '\x1b[7mdef\x1b[27m'])
		expect(row({ text: 'abc', cursor: 1, anchor: 1 })).toEqual(['abc'])
	})
})
