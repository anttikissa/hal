// The browser must distinguish a fresh socket from a fresh visible session.
import { afterEach, expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { wake } from './wake.ts'
import { view } from './view.ts'
import { fx, meta, ts, sessionId, snapshot, snapOf, useApp } from './app-fixture.test.ts'

useApp()
let original = { reconnect: connection.reconnect, visible: wake.visible }
afterEach(() => {
	connection.reconnect = original.reconnect
	wake.visible = original.visible
})

test('disconnect repaints; only the visible snapshot restores live activity and the draft stays', () => {
	app.state.shown = sessionId
	app.onEvent(snapshot({ type: 'running', phase: 'streaming' }))
	app.input('unsent draft')
	let transcript = app.state.view.transcript
	expect(app.fresh()).toBe(true)
	let redraws = fx.redraws
	app.onState({ type: 'joining' })
	expect(fx.redraws).toBeGreaterThan(redraws)
	expect(app.fresh()).toBe(false)
	expect(app.state.view.transcript).toBe(transcript)
	app.onState({ type: 'connected', role: 'client' })
	app.onEvent(snapOf('background'))
	expect(app.fresh()).toBe(false)
	expect(view.line(app.state.view, true, app.fresh())).toEqual({ text: 'Updating...', tone: 'idle' })
	app.onEvent(snapshot({ type: 'idle' }))
	expect(app.fresh()).toBe(true)
	expect(view.line(app.state.view, true, app.fresh()).text).toBe('idle')
	expect(app.state.text).toBe('unsent draft')
	expect(drafts.text(sessionId)).toBe('unsent draft')
})

test('wake coalesces return signals and catches a clock gap without network polling', () => {
	let visible = true
	wake.visible = () => visible
	wake.state.refreshed = -Infinity
	wake.state.checked = Date.now()
	let reopened: (string | undefined)[] = []
	connection.reconnect = (id) => void reopened.push(id)
	app.state.shown = sessionId
	app.onEvent(snapshot({ type: 'running', phase: 'streaming' }))
	wake.check()
	expect(reopened).toEqual([])
	visible = false
	wake.visibility()
	wake.refresh()
	expect(app.fresh()).toBe(false)
	expect(reopened).toEqual([])
	visible = true
	wake.visibility()
	wake.refresh()
	wake.restored({ persisted: true } as PageTransitionEvent)
	expect(reopened).toEqual([sessionId])
	wake.state.refreshed = -Infinity
	wake.state.checked = Date.now() - wake.gapMs - 1
	wake.check()
	expect(reopened).toEqual([sessionId, sessionId])
	wake.check()
	expect(reopened).toHaveLength(2)
	wake.restored({ persisted: false } as PageTransitionEvent)
	expect(reopened).toHaveLength(2)
})

for (let hidden of [false, true])
	test(`refreshed older pages arrive together with live updates; hidden=${hidden}`, () => {
		let records = Array.from({ length: 6 }, (_, i) => ({ type: 'output', text: `record ${i + 1}`, n: i + 1, ts }))
		let tail = () =>
			({
				type: 'snapshot',
				sessionId,
				snapshot: {
					meta,
					history: records.slice(4),
					older: 200,
					state: { type: 'running', phase: 'streaming' },
					turn: { provider: 'fake', blocks: [{ type: 'text', text: 'before' }] },
				},
			}) as Event
		let page = (before: number, start: number, older?: number) =>
			({
				type: 'history',
				sessionId,
				before,
				records: records.slice(start, start + 2),
				older,
			}) as Event
		app.state.shown = sessionId
		app.onEvent(tail())
		app.older()
		app.onEvent({ type: 'history', sessionId, before: 200, records: records.slice(0, 4) } as Event)
		let before = app.state.view.transcript
		if (hidden) {
			app.state.cached.set(sessionId, app.state.view)
			app.state.background.add(sessionId)
			app.state.shown = 'other'
			app.state.view = {}
		}
		let shown = () => (hidden ? app.state.cached.get(sessionId)! : app.state.view)
		app.onState({ type: 'joining' })
		app.onEvent(tail())
		expect(shown().transcript).toBe(before)
		expect(app.state.fresh.has(sessionId)).toBe(false)
		expect(fx.sent.at(-1)).toMatchObject({ type: 'history', before: 200 })
		app.onEvent(page(200, 2, 100))
		expect(shown().transcript).toBe(before)
		expect(fx.sent.at(-1)).toMatchObject({ type: 'history', before: 100 })
		// A second connection must still restore the whole original range.
		app.onState({ type: 'joining' })
		app.onEvent(tail())
		app.onEvent(page(200, 2, 100))
		expect(shown().transcript).toBe(before)
		app.onEvent({ type: 'stream', sessionId, event: { type: 'text', text: ' during refresh' } })
		app.onEvent({ type: 'turn-end', sessionId, status: 'completed' })
		app.onEvent({ type: 'state', sessionId, state: { type: 'idle' } })
		app.onEvent({ type: 'warning', text: 'visible failure' })
		expect(app.state.view.notice).toBe('visible failure')
		app.input('draft typed while refreshing')
		app.onEvent({
			type: 'question',
			sessionId,
			id: 'fresh-question',
			form: { text: 'Continue?', fields: [{ type: 'text', name: 'answer' }] },
		})
		app.onEvent({ type: 'state', sessionId, state: { type: 'blocked', reason: 'question' } })
		expect(shown().form).toBeUndefined()
		records[1]!.text = 'fresh older record'
		app.onEvent(page(100, 0))
		expect(app.state.refreshing.size).toBe(0)
		expect(app.state.fresh.has(sessionId)).toBe(true)
		expect(shown().transcript!.state).toEqual({ type: 'blocked', reason: 'question' })
		expect(shown().form?.id).toBe('fresh-question')
		let texts = shown().transcript!.items.flatMap((i) => ('text' in i ? [i.text] : []))
		expect(texts).toContain('fresh older record')
		expect(texts).toContain('before during refresh')
		expect(texts).toContain('record 1')
		expect(app.state.text).toBe('draft typed while refreshing')
		// Rewritten history replaces the cache instead of resurrecting it.
		app.onEvent({
			type: 'snapshot',
			sessionId,
			snapshot: { meta, history: records.slice(0, 1), state: { type: 'idle' } },
		} as Event)
		expect(shown().transcript!.items.flatMap((i) => ('text' in i ? [i.text] : []))).toEqual(['record 1'])
	})
