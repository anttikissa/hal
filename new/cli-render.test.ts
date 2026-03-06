import { describe, expect, test } from 'bun:test'
import { render, emptyState, type RenderState } from './cli-render.ts'

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

	test('no-op when lines unchanged', () => {
		const lines = ['hello', 'world']
		const prev: RenderState = { lines: [...lines], cursorRow: 1 }
		const { buf } = render(lines, prev, { row: 1, col: 3 }, screen)
		expect(buf).toBe('')
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
