import { afterAll, afterEach, expect, test } from 'bun:test'
import { closeSync, chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from './app.ts'
import { redrawTrace } from './redraw-trace.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'
import type { Frame } from './frame.ts'

let dir = mkdtempSync(join(tmpdir(), 'hal-redraw-'))
let file = join(dir, 'trace.jsonl')
const originals = { event: app.onEvent, keys: app.onKeys, redraw: terminal.redraw, resize: terminal.onResize, max: redrawTrace.maxRecords }
afterEach(() => {
	redrawTrace.stop()
	render.reset()
	app.onEvent = originals.event
	app.onKeys = originals.keys
	terminal.redraw = originals.redraw
	terminal.onResize = originals.resize
	redrawTrace.maxRecords = originals.max
	rmSync(dir, { recursive: true, force: true })
	dir = mkdtempSync(join(tmpdir(), 'hal-redraw-'))
	file = join(dir, 'trace.jsonl')
})
// Avoid creating one final temp dir after the last test.
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const frame = (lines: string[]): Frame => ({ lines, cursor: { row: lines.length - 1, col: 0 }, promptScroll: 0, history: lines.length })
const capture = () => readFileSync(file, 'utf8').trim().split('\n').map((s) => JSON.parse(s))

test('inert until opted in; traces geometry and clears without altering output or leaking contents', () => {
	expect(redrawTrace.state.fd).toBeUndefined()
	let content = 'PRIVATE conversation, token, hostname, tool output'
	let first = frame(Array.from({ length: 20 }, (_, i) => `${content} ${i}`))
	let shrink = frame(first.lines.slice(0, -1))
	let expected = [render.paint(first, 10), render.paint(shrink, 10)]
	render.reset()
	redrawTrace.start(file)
	expect([render.paint(first, 10), render.paint(shrink, 10)]).toEqual(expected)
	let rows = capture()
	expect(rows[0].clear).toBe(false)
	expect(rows[1]).toMatchObject({ reason: 'shrink', clear: true, home: true, oldRows: 20, newRows: 19, writableTop: 10 })
	expect(readFileSync(file, 'utf8')).not.toContain(content)
	expect(lstatSync(file).mode & 0o777).toBe(0o600)
})

test('records immutable-row changes separately from writable diffs and unchanged paints', () => {
	redrawTrace.start(file)
	let lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
	render.paint(frame(lines), 10)
	lines = [...lines.slice(0, -1), 'new tail']
	render.paint(frame(lines), 10)
	render.paint(frame(lines), 10)
	lines = ['new old row', ...lines.slice(1)]
	render.paint(frame(lines), 10)
	expect(capture().map((r) => [r.reason, r.clear])).toEqual([
		['diff', false], ['diff', false], ['unchanged', false], ['immutable-row-changed', true],
	])
})

test('attributes throttle-coalesced paints to event and keyboard sources, not their payloads', () => {
	let writes: string[] = []
	render.init({ size: () => ({ rows: 10, cols: 40 }), write: (s) => writes.push(s) })
	app.onEvent = () => render.request()
	app.onKeys = () => render.request()
	redrawTrace.start(file)
	app.onEvent({ type: 'warning', text: 'PRIVATE message' })
	app.onEvent({ type: 'tool-output', sessionId: 'PRIVATE session', id: 'PRIVATE id', at: 0, chunk: 'PRIVATE output' })
	app.onKeys([{ key: 'PRIVATE typed key', alt: false, ctrl: false, shift: false, cmd: false }])
	render.draw()
	let rows = capture()
	expect(rows[0].causes).toContain('event:warning')
	expect(rows.at(-1).causes).toEqual(['event:tool-output', 'app.onKeys'])
	expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE')
	expect(writes.length).toBeGreaterThan(0)
})

test('hooks redraw callbacks installed after local configuration and restores them on stop', () => {
	redrawTrace.start(file)
	render.init({ size: () => ({ rows: 10, cols: 40 }), write: () => {} })
	terminal.redraw()
	terminal.onResize()
	expect(capture().map((r) => r.causes)).toEqual([['terminal.redraw'], ['terminal.onResize']])
	redrawTrace.stop()
	expect(redrawTrace.state.fd).toBeUndefined()
	terminal.redraw()
	expect(capture()).toHaveLength(2)
})

test('stops at its bound and does not overwrite a subsequent override', () => {
	let base = render.paintParts
	redrawTrace.maxRecords = 1
	redrawTrace.start(file)
	let wrapper = render.paintParts
	let subsequent = (...args: Parameters<typeof base>) => wrapper(...args)
	render.paintParts = subsequent
	render.paint(frame(['a']), 10)
	expect(redrawTrace.state.fd).toBeUndefined()
	expect(render.paintParts).toBe(subsequent)
	render.paint(frame(['b']), 10)
	expect(capture()).toHaveLength(1)
	render.paintParts = base
})

test('rejects symlinks and tightens permissions when appending a capture', () => {
	redrawTrace.start(file)
	render.paint(frame(['a']), 10)
	redrawTrace.stop()
	chmodSync(file, 0o644)
	redrawTrace.start(file)
	render.paint(frame(['b']), 10)
	redrawTrace.stop()
	expect(capture()).toHaveLength(2)
	expect(lstatSync(file).mode & 0o777).toBe(0o600)
	let link = join(dir, 'link')
	symlinkSync(file, link)
	expect(() => redrawTrace.start(link)).toThrow()
})

test('a failed trace write stops tracing without disrupting renderer output', () => {
	redrawTrace.start(file)
	closeSync(redrawTrace.state.fd!)
	expect(() => render.paint(frame(['still renders']), 10)).not.toThrow()
	expect(redrawTrace.state.fd).toBeUndefined()
	expect(redrawTrace.state.error).toBeDefined()
})
