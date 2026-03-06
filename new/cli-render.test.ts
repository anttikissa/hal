import { describe, expect, test } from 'bun:test'
import { render, emptyState, type RenderState } from './cli-diff-engine.ts'

const cursor = { row: 0, col: 1 }
const screen = 24

// Helper: strip sync markers for readability
const strip = (buf: string) =>
	buf.replace(/\x1b\[\?2026[hl]/g, '')

describe('cli-render', () => {
	test('first render writes all lines', () => {
		const lines = ['hello', 'world']
		const { buf, state } = render(lines, emptyState, { row: 1, col: 3 }, screen)
		const s = strip(buf)
		expect(s).toContain('hello')
		expect(s).toContain('world')
		expect(s).not.toContain('\x1b[2J') // no clear on first render
		expect(state.lines).toEqual(lines)
	})

	test('no-op when lines and cursor unchanged', () => {
		const lines = ['hello', 'world']
		const prev: RenderState = { lines: [...lines], cursorRow: 1, cursorCol: 3 }
		const { buf } = render(lines, prev, { row: 1, col: 3 }, screen)
		expect(buf).toBe('')
	})

	test('repositions cursor when only cursor moved', () => {
		const lines = ['hello', 'world']
		const prev: RenderState = { lines: [...lines], cursorRow: 1, cursorCol: 3 }
		const { buf } = render(lines, prev, { row: 1, col: 5 }, screen)
		expect(buf).not.toBe('')
		expect(buf).toContain('\x1b[5G')
	})

	test('diffs single changed line', () => {
		const prev: RenderState = { lines: ['aaa', 'bbb', 'ccc'], cursorRow: 2 }
		const next = ['aaa', 'BBB', 'ccc']
		const { buf, state } = render(next, prev, { row: 2, col: 1 }, screen)
		const s = strip(buf)
		// Should move up to row 1 and rewrite it
		expect(s).toContain('BBB')
		expect(s).not.toContain('aaa') // unchanged, not rewritten
		expect(s).not.toContain('ccc') // unchanged, not rewritten
		expect(state.lines).toEqual(next)
	})

	test('appends new lines', () => {
		const prev: RenderState = { lines: ['aaa', 'bbb'], cursorRow: 1 }
		const next = ['aaa', 'bbb', 'ccc']
		const { buf } = render(next, prev, { row: 2, col: 1 }, screen)
		const s = strip(buf)
		expect(s).toContain('ccc')
		expect(s).toContain('\r\n') // appended via newline
	})

	test('clears leftover lines when content shrinks', () => {
		const prev: RenderState = { lines: ['a', 'b', 'c', 'd'], cursorRow: 3 }
		const next = ['a', 'b']
		const { buf, state } = render(next, prev, { row: 1, col: 1 }, screen)
		const s = strip(buf)
		// Should contain erase-line sequences for the 2 removed lines
		const eraseCount = (s.match(/\x1b\[2K/g) || []).length
		expect(eraseCount).toBeGreaterThanOrEqual(2)
		expect(state.lines).toEqual(next)
	})

	test('skips changes entirely above viewport', () => {
		// 100 lines, screen is 24 — viewport top is ~76
		const prev: RenderState = {
			lines: Array.from({ length: 100 }, (_, i) => `line ${i}`),
			cursorRow: 99,
		}
		const next = [...prev.lines]
		next[0] = 'CHANGED' // above viewport
		const { buf } = render(next, prev, { row: 99, col: 1 }, screen)
		expect(buf).toBe('')
	})

	test('full clear when changes span viewport boundary', () => {
		const prev: RenderState = {
			lines: Array.from({ length: 100 }, (_, i) => `line ${i}`),
			cursorRow: 99,
		}
		const next = [...prev.lines]
		next[0] = 'CHANGED'  // above viewport
		next[99] = 'CHANGED' // inside viewport
		const { buf } = render(next, prev, { row: 99, col: 1 }, screen)
		const s = strip(buf)
		expect(s).toContain('\x1b[2J') // full clear
	})

	test('wraps output in sync markers', () => {
		const { buf } = render(['hi'], emptyState, cursor, screen)
		expect(buf.startsWith('\x1b[?2026h')).toBe(true)
		expect(buf.endsWith('\x1b[?2026l')).toBe(true)
	})

	test('positions cursor at target', () => {
		const { buf } = render(['line0', 'line1', 'prompt'], emptyState, { row: 2, col: 5 }, screen)
		const s = strip(buf)
		// Should set column to 5
		expect(s).toContain('\x1b[5G')
		// Should show cursor
		expect(s).toContain('\x1b[?25h')
	})
})

describe('patchLine', () => {
	const long = (mid: string) => `this is a very long line that has very little changing (${mid}) and then there's a lot of text after this too`

	test('same-length line patches only the changed bytes', () => {
		const old = [long('1.0s')]
		const nw = [long('1.1s')]
		const prev: RenderState = { lines: old, cursorRow: 0, cursorCol: 1 }
		const { buf } = render(nw, prev, cursor, screen)
		const s = strip(buf)
		// Should NOT contain erase-line (full rewrite)
		expect(s).not.toContain('\x1b[2K')
		// Should position cursor at the diff column and write the changed char(s)
		expect(s).toMatch(/\x1b\[\d+G/)
		// Should be much shorter than a full rewrite
		expect(buf.length).toBeLessThan(old[0].length)
	})

	test('patches with SGR replay when color is active at diff point', () => {
		const old = ['\x1b[31m' + 'x'.repeat(30) + 'AAA' + 'y'.repeat(30) + '\x1b[0m']
		const nw = ['\x1b[31m' + 'x'.repeat(30) + 'BBB' + 'y'.repeat(30) + '\x1b[0m']
		const prev: RenderState = { lines: old, cursorRow: 0, cursorCol: 1 }
		const { buf } = render(nw, prev, cursor, screen)
		const s = strip(buf)
		// Should patch, not full rewrite
		expect(s).not.toContain('\x1b[2K')
		// Should replay the SGR before the changed bytes
		expect(buf).toContain('\x1b[31m')
		expect(s).toContain('BBB')
	})

	test('patches when SGR was reset before diff point', () => {
		const prefix = '\x1b[31mred\x1b[0m ' + 'x'.repeat(30)
		const old = [prefix + 'AAA' + 'y'.repeat(30)]
		const nw = [prefix + 'BBB' + 'y'.repeat(30)]
		const prev: RenderState = { lines: old, cursorRow: 0, cursorCol: 1 }
		const { buf } = render(nw, prev, cursor, screen)
		const s = strip(buf)
		expect(s).not.toContain('\x1b[2K')
		expect(s).toContain('BBB')
	})

	test('short lines patch when it saves bytes', () => {
		const prev: RenderState = { lines: ['hello world'], cursorRow: 0, cursorCol: 1 }
		const { buf } = render(['hello WORLD'], prev, cursor, screen)
		// 'hello ' is common prefix (6 vis cols), patch is \x1b[7GWORLD (10b) vs full rewrite (15b)
		expect(strip(buf)).not.toContain('\x1b[2K')
	})

	test('different-length lines rewrite from diff point', () => {
		const old = ['prefix ' + 'a'.repeat(40) + ' short']
		const nw = ['prefix ' + 'a'.repeat(40) + ' much longer suffix here']
		const prev: RenderState = { lines: old, cursorRow: 0, cursorCol: 1 }
		const { buf } = render(nw, prev, cursor, screen)
		const s = strip(buf)
		expect(s).not.toContain('\x1b[2K')
		expect(s).toContain('much longer')
	})
})