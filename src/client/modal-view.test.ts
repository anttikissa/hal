// Modals in the frame (modal-view.ts), seen through frame.build.
import { expect, test } from 'bun:test'
import { colors } from '../common/colors.ts'
import { modals } from '../common/modals.ts'
import { oklch } from '../common/oklch.ts'
import { strings } from '../common/strings.ts'
import type { Shown as Item, Transcript } from '../common/transcript.ts'
import { frame, type View } from './frame.ts'

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

// A modal over a transcript of full rows of x, so every column the box
// leaves free shows transcript.
const modalView = (spec: Parameters<typeof modals.open>[0], n = 40): View => ({ ...view([{ type: 'text', text: 'x'.repeat(58 * n) }]), modal: modals.open(spec) })
const search = { text: 'Models', fields: [{ type: 'text' as const, name: 'q', label: 'Search' }] }
const names = (n: number) => Array.from({ length: n }, (_, i) => `model ${i}`)

// Where the box is: first and last frame row, and its left column.
function box(lines: string[]): { top: number; bottom: number; left: number; right: number } {
	let rows = lines.map(strip)
	let top = rows.findIndex((r) => r.includes('┌'))
	let bottom = rows.findIndex((r) => r.includes('└'))
	return { top, bottom, left: rows[top]!.indexOf('┌'), right: rows[top]!.indexOf('┐') }
}

test('a modal draws over the transcript: transcript, a blank column, the outline, the contents', () => {
	let v = modalView({ title: 'Models', form: search, items: names(3) })
	let f = frame.build(v, 60, 30)
	let under = frame.build({ ...v, modal: undefined }, 60, 30).lines.map(strip)
	let b = box(f.lines)
	expect(b.bottom - b.top + 1).toBe(24)
	// Drawn over the frame, not added to it.
	expect(f.lines.length).toBe(frame.build(modalView({ title: 'Models' }), 60, 30).lines.length)
	for (let i = b.top; i <= b.bottom; i++) {
		let row = strip(f.lines[i]!)
		expect(strings.visLen(f.lines[i]!)).toBeLessThanOrEqual(60)
		expect(row.slice(0, b.left - 1).trimEnd()).toBe(under[i]!.slice(0, b.left - 1).trimEnd())
		expect(row.slice(1, b.left - 1)).toMatch(/^(x+|─+|> *| *)$/)
		expect(row[b.left - 1]).toBe(' ')
		expect('┌│└').toContain(row[b.left]!)
		expect('┐│┘').toContain(row[b.right]!)
		expect(row[b.right + 1]).toBe(' ')
		expect(row.slice(b.right + 2).trimEnd()).toBe(under[i]!.slice(b.right + 2).trimEnd())
	}
	let rows = f.lines.map(strip)
	expect(rows[b.top]).toContain('Models')
	expect(rows.find((r) => r.includes('Search:'))).toBeDefined()
	expect(rows.find((r) => r.includes('> model 0'))).toBeDefined()
	// The box sits on the screen: the frame's last 30 rows.
	expect(b.top).toBeGreaterThanOrEqual(f.lines.length - 30)
})

test('a modal keeps its height whatever it holds or is typed into it', () => {
	let at = (spec: Parameters<typeof modals.open>[0], typed = '', rows = 30) => {
		let v = modalView(spec)
		for (let c of typed) v.modal = modals.step(v.modal!, { key: c, text: c }).state
		return box(frame.build(v, 60, rows).lines)
	}
	let first = at({ title: 'Models', form: search, items: names(300) })
	for (let spec of [{ title: 'Models', form: search }, { title: 'Models', items: names(2) }]) expect(at(spec)).toEqual(first)
	expect(at({ title: 'Models', form: search, items: names(300) }, 'a long search '.repeat(9))).toEqual(first)
	// 80% of the rows, at most 36.
	let tall = at({ title: 'Models', items: names(2) }, '', 100)
	expect(tall.bottom - tall.top + 1).toBe(36)
})

test('a modal list scrolls to its selection; the cursor is in the search box', () => {
	let v = modalView({ title: 'Models', form: search, items: names(300) })
	for (let c of 'op') v.modal = modals.step(v.modal!, { key: c, text: c }).state
	v.modal = { ...v.modal!, selected: 150 }
	let f = frame.build(v, 60, 30)
	let rows = f.lines.map(strip)
	expect(rows.some((r) => r.includes('> model 150'))).toBe(true)
	expect(rows.some((r) => r.includes(' model 0 '))).toBe(false)
	let at = rows.findIndex((r) => r.includes('Search: op'))
	expect(f.cursor).toEqual({ row: at, col: rows[at]!.indexOf('Search: op') + 'Search: op'.length })
})

test('a modal over a short frame still gets its full height', () => {
	let v: View = { prompt: { text: 'typed', cursor: 5 }, modal: modals.open({ title: 'Log in', form: search }) }
	let f = frame.build(v, 60, 30)
	let b = box(f.lines)
	expect(b.bottom - b.top + 1).toBe(24)
	expect(f.lines.length).toBeLessThanOrEqual(30)
})

test('transcript right of a modal keeps its colour', () => {
	let v: View = { ...view([{ type: 'prompt', text: 'y'.repeat(58 * 30) }]), modal: modals.open({ title: 'Models' }) }
	let f = frame.build(v, 60, 30)
	let b = box(f.lines)
	let row = f.lines[b.top + 1]!
	let right = row.slice(row.lastIndexOf('│'))
	expect(right).toContain(`48;2;${oklch.toRgb(colors.user().bg!).join(';')}`)
})

test('a modal never makes a row wider than the terminal, however small', () => {
	for (let cols = 3; cols < 70; cols++) {
		for (let rows of [1, 2, 3, 5, 30]) {
			let v = modalView({ title: 'A title longer than small boxes', hint: 'enter: pick', form: search, items: names(40) }, 3)
			v.modal = { ...v.modal!, selected: 20 }
			let f = frame.build(v, cols, rows)
			for (let line of f.lines) expect(strings.visLen(line)).toBeLessThanOrEqual(cols)
			expect(f.cursor.col).toBeLessThan(Math.max(1, cols))
			expect(f.cursor.row).toBeLessThan(f.lines.length)
		}
	}
})

test('search matches in a modal list are bold, then the row carries on unchanged', () => {
	let v = modalView({ title: 'Models', form: search, items: ['gpt 6 sol', 'opus 5.5'] })
	v = { ...v, modal: { ...v.modal!, query: 'sol', selected: 1 } }
	let row = frame.build(v, 60, 30).lines.find((l) => strip(l).includes('gpt 6 sol'))!
	expect(row).toMatch(/gpt 6 \x1b\[1m(\x1b\[[0-9;]*m)*sol\x1b\[22m/)
	expect(strip(row)).toContain('  gpt 6 sol')
	let other = frame.build(v, 60, 30).lines.find((l) => strip(l).includes('opus 5.5'))!
	expect(other).not.toContain('\x1b[1m')
})
