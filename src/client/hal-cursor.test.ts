import { afterEach, beforeEach, expect, test } from 'bun:test'
import { colors } from '../common/colors.ts'
import type { Event, Snapshot } from '../common/protocol.ts'
import type { SessionState } from '../common/states.ts'
import { ansi } from './ansi.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { frame } from './frame.ts'
import { halCursor } from './hal-cursor.ts'
import { pulse } from './pulse.ts'
import { render } from './render.ts'

// The Hal cursor as the user sees it, driven by host events through the
// app. Time is the pulse's clock, set by hand: beat 0 lights both blinks.

let now = 0
const saved = { now: pulse.now, send: app.send, show: render.show, frameMs: render.frameMs }
beforeEach(() => {
	app.reset()
	render.reset()
	now = 0
	pulse.now = () => now
	app.send = () => {}
})
afterEach(() => {
	Object.assign(pulse, { now: saved.now })
	Object.assign(render, { show: saved.show, frameMs: saved.frameMs })
	app.send = saved.send
	app.reset()
	render.reset()
})

const snapshot = (state: SessionState = { type: 'idle' }): Event => {
	let snap: Snapshot = { meta: { id: 's1', cwd: '/', model: 'anthropic/x', createdAt: '' }, history: [], state }
	return { type: 'snapshot', sessionId: 's1', snapshot: snap }
}
const state = (s: SessionState) => app.onEvent({ type: 'state', sessionId: 's1', state: s })
const stream = (event: any) => app.onEvent({ type: 'stream', sessionId: 's1', event })
const start = () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'turn-start', sessionId: 's1', provider: 'anthropic', prompt: 'hi' })
	state({ type: 'running', phase: 'streaming' })
}

// The frame's rows as text; the cursor block kept, its colour named.
function rows(cols = 40): string[] {
	let hal = ansi.sgr({ fg: colors.assistant().cursor! })
	let think = ansi.sgr({ fg: colors.thinking().fg! })
	return frame
		.build(appView.view(), cols)
		.lines.map((l) => l.replaceAll(hal + '█', '{hal}').replaceAll(think + '█', '{think}').replace(new RegExp('\x1b\\[[0-9;]*m', 'g'), '').trimEnd())
}
// The rows after the last transcript row, `after`.
const below = (after: string) => {
	let r = rows()
	return r.slice(r.lastIndexOf(after) + 1, r.lastIndexOf(after) + 4)
}

test('the cursor follows the streamed text, in the thinking colour while thinking', () => {
	start()
	stream({ type: 'thinking', text: 'hmm' })
	expect(rows()).toContain(' hmm{think}')
	stream({ type: 'signature', value: 'x' })
	expect(rows().join('\n')).not.toContain('{think}')
	stream({ type: 'text', text: 'Hello' })
	expect(rows()).toContain(' Hello{hal}')
	stream({ type: 'text', text: ' world' })
	let r = rows()
	expect(r).toContain(' Hello world{hal}')
	// Only one cursor, and no idle one while streaming.
	expect(r.join('\n').split('{hal}').length).toBe(2)
})

test('a full last row puts the cursor on the next row, never in the last column', () => {
	start()
	stream({ type: 'text', text: 'x'.repeat(18) })
	let r = rows(20)
	let at = r.indexOf(' ' + 'x'.repeat(18))
	expect(r[at + 1]).toBe(' {hal}')
	// Dark, the row stays: the frame's height never blinks.
	now = pulse.ms
	expect(rows(20).length).toBe(r.length)
})

test('the cursor goes when the block ends; blank, cursor, blank rows follow the transcript', () => {
	start()
	stream({ type: 'text', text: 'Hello' })
	app.onEvent({ type: 'tool-results', sessionId: 's1', results: [] } as any)
	// Still working (tools): the idle cursor is bright.
	expect(below(' Hello')).toEqual(['', ' {hal}', ''])
	app.onEvent({ type: 'turn-end', sessionId: 's1', status: 'completed' })
	state({ type: 'idle' })
	// Finished: it fades from the Hal colour to grey.
	now = halCursor.fadeMs * 2
	expect(below(' Hello')).toEqual(['', ' █', ''])
	expect(rows().join('\n')).not.toContain('{hal}')
	// It blinks: dark two beats later, the row stays.
	now += 2 * pulse.ms
	expect(below(' Hello')).toEqual(['', '', ''])
})

test('a finished session never seen working here shows the grey cursor at once', () => {
	app.onEvent(snapshot())
	let lines = frame.build(appView.view(), 40).lines
	let grey = ansi.sgr({ fg: colors.assistant().cursorIdle! }) + '█'
	expect(lines.some((l) => l.includes(grey))).toBe(true)
})

test('no timer runs when nothing blinks', () => {
	render.show = () => {}
	app.show()
	expect(pulse.running()).toBe(false)
	app.onEvent(snapshot())
	expect(pulse.running()).toBe(true)
	app.reset()
	expect(pulse.running()).toBe(false)
})

test('a blink phase rewrites the cursor row alone', () => {
	let written = ''
	render.init({ write: (s) => void (written += s), size: () => ({ rows: 30, cols: 40 }) })
	render.frameMs = 0
	app.onEvent(snapshot())
	for (let i = 0; i < 5; i++) app.onEvent({ type: 'command', sessionId: 's1', text: `/cmd${i}` } as any)
	render.draw()
	written = ''
	now = 2 * pulse.ms
	app.beat()
	render.draw()
	expect(written.split('\x1b[2K').length).toBe(2)
	// A beat that changes nothing paints nothing.
	written = ''
	now = 2.5 * pulse.ms
	app.beat()
	expect(written).toBe('')
})

test('the pulse beats on wall-clock beats until nobody keeps it', async () => {
	pulse.now = saved.now
	let ms = pulse.ms
	pulse.ms = 5
	let beats: number[] = []
	pulse.keep((b) => beats.push(b))
	await Bun.sleep(30)
	pulse.keep(null)
	let n = beats.length
	await Bun.sleep(15)
	pulse.ms = ms
	expect(n).toBeGreaterThan(1)
	expect(beats.length).toBe(n)
	for (let i = 1; i < n; i++) expect(beats[i]).toBe(beats[i - 1]! + 1)
})

test('a blinking tab indicator keeps the pulse and blinks with it', () => {
	let shown: string[] = []
	render.show = (v) => void shown.push(JSON.stringify(v.tabs))
	let tab = (state: SessionState) => ({ id: 't1', name: 't1', cwd: '/', model: 'm', state })
	app.onEvent({ type: 'tabs', tabs: [tab({ type: 'idle' })] })
	expect(pulse.running()).toBe(false)
	app.onEvent({ type: 'tabs', tabs: [tab({ type: 'running', phase: 'tools' })] })
	expect(pulse.running()).toBe(true)
	let bar = () => frame.build(appView.view(), 40).lines.find((l) => l.includes('ctrl-t: new'))
	let lit = bar()
	now = 2 * pulse.ms
	let count = shown.length
	app.beat()
	expect(shown.length).toBe(count + 1)
	expect(bar()).not.toBe(lit)
	now = 4 * pulse.ms
	expect(bar()).toBe(lit)
})
