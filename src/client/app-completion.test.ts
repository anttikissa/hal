// App tests for Tab completion, the model picker, prompt rows and the example text.

import { expect, test } from 'bun:test'
import { drafts } from '../common/drafts.ts'
import { placeholders } from '../common/placeholders.ts'
import { strings } from '../common/strings.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { frame } from './frame.ts'
import { pulse } from './pulse.ts'
import { useApp, sent, snapshot, key, type, enter } from './app-fixture.test.ts'

useApp()

test('Tab on a command asks the host to complete it; the answer fills the prompt if it is unchanged', () => {
	app.onEvent(snapshot())
	type('hello')
	app.onKeys([key('tab')])
	expect(sent).toEqual([])
	// Elsewhere it is a literal tab.
	expect(app.state.prompt.text).toBe('hello\t')
	app.onKeys(Array.from({ length: 6 }, () => key('backspace')))
	type('/cd ~/pro')
	app.onKeys([key('tab')])
	expect(sent).toEqual([{ type: 'complete', sessionId: 's1', text: '/cd ~/pro' }])
	app.onEvent({
		type: 'completions',
		sessionId: 's1',
		text: '/cd ~/pro',
		items: ['/cd ~/projects/', '/cd ~/projection/'],
	})
	expect(app.state.prompt).toMatchObject({ text: '/cd ~/project', cursor: 13 })
	expect(drafts.text('s1')).toBe('/cd ~/project')
	// Typed on meanwhile: a late answer is dropped.
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/cd ~/pro', items: ['/cd ~/prof/'] })
	expect(app.state.prompt.text).toBe('/cd ~/project')
})

test('model Tab fills the alias while retaining qualified alternatives and rejecting a late reply', () => {
	app.onEvent(snapshot())
	type('/model astr')
	app.onKeys([key('tab')])
	let event = {
		type: 'completions' as const,
		sessionId: 's1',
		text: '/model astr',
		items: ['/model astra', '/model openrouter/openai/gpt-6-astra'],
	}
	app.onEvent(event)
	expect(app.state.prompt).toMatchObject({ text: '/model astra', cursor: 12 })
	expect(drafts.text('s1')).toBe('/model astra')
	expect(appView.view().choices).toEqual(['astra', 'openrouter/openai/gpt-6-astra'])
	app.onEvent({ ...event, items: ['/model other'] })
	expect(app.state.prompt.text).toBe('/model astra')
})

test("completion leaves other notices alone and never uncovers the tab's state by clearing one", () => {
	app.onEvent(snapshot('s1', { type: 'error', message: 'no credits' }))
	app.onEvent({ type: 'warning', text: 'Web is on port 9002' })
	let before = [appView.view().why, appView.view().notice]
	expect(before).toEqual([expect.stringContaining('no credits'), 'Web is on port 9002'])
	type('/sta')
	app.onKeys([key('tab')])
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/sta', items: ['/status '] })
	expect([appView.view().why, appView.view().notice]).toEqual(before)
	type('x')
	app.onKeys([key('tab')])
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/status x', items: [] })
	expect(appView.view().notice).toBe('no completions')
	app.onKeys([key('backspace'), key('tab')])
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/status ', items: ['/status '] })
	expect(appView.view().notice).toBeUndefined()
})

test('several completions are listed in the help row until the next key, and Up still recalls history', () => {
	app.onEvent(snapshot())
	type('earlier')
	enter()
	app.onEvent({ type: 'prompt', sessionId: 's1', texts: ['earlier'] })
	type('/cd ~/pro')
	let before = frame.build(appView.view(), 40)
	app.onKeys([key('tab')])
	let names = Array.from({ length: 12 }, (_, i) => `project-${i}/`)
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/cd ~/pro', items: names.map((n) => `/cd ~/${n}`) })
	let f = frame.build(appView.view(), 40)
	// The first names, in order, on the last row; the frame keeps its height.
	let help = f.lines.at(-1)!.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, '')
	expect(help).toMatch(/project-0\/ +project-1\/ /)
	expect(strings.visLen(f.lines.at(-1)!)).toBeLessThanOrEqual(40)
	expect(f.lines.length).toBe(before.lines.length)
	expect(appView.view().notice).toBeUndefined()
	app.onKeys([key('up')])
	expect(appView.view().choices).toBeUndefined()
	expect(app.state.prompt.text).toBe('earlier')
	let after = frame.build(appView.view(), 40)
	expect(after.lines.join('')).not.toContain('project-')
})

test('Ctrl-M asks the host for the models; the picker filters as you type and Enter switches', () => {
	app.onEvent(snapshot())
	type('draft')
	app.onKeys([{ ...key('m'), ctrl: true }])
	expect(sent).toEqual([{ type: 'models', sessionId: 's1' }])
	expect(appView.view().modal).toBeUndefined()
	let items = ['anthropic/x', 'openrouter/stepfun/step-3.5-flash', 'anthropic/claude-opus-5-5']
	app.onEvent({ type: 'models', sessionId: 's1', current: 'anthropic/x', items })
	let modal = appView.view().modal!
	expect(modal.tree?.rows[modal.selected]?.id).toBe('anthropic/x')
	// An unsupported leaf's arrows do nothing, not navigate to a provider.
	app.onKeys([key('left')])
	expect(appView.view().modal!.tree?.rows[appView.view().modal!.selected]?.id).toBe('anthropic/x')
	type('opus-5.5')
	expect(appView.view().modal!.items[appView.view().modal!.selected]).toMatch(/anthropic\/claude-opus-5-5$/)
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: '/model anthropic/claude-opus-5-5' })
	expect(appView.view().modal).toBeUndefined()
	expect(app.state.prompt.text).toBe('draft')
})

test('a model list for another session opens nothing', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'models', sessionId: 's2', current: 'a/b', items: ['a/b'] })
	expect(appView.view().modal).toBeUndefined()
})

test('Up moves by the rows the terminal draws, at its width', () => {
	let cols = app.cols
	try {
		app.onEvent(snapshot())
		type('x'.repeat(30))
		app.cols = () => 20
		app.onKeys([key('up')])
		let f = frame.build(appView.view(), 20)
		expect(f.lines[f.cursor.row + 1]).toContain('xx')
		expect(f.lines[f.cursor.row + 2]).toContain('─')
		expect(appView.view().prompt.cursor).toBe(30 - frame.promptWidth(20))
	} finally {
		app.cols = cols
	}
})

test('typing erases the example from its left, right of the typed text, then it is gone', () => {
	let now = 1_000_000,
		saved = pulse.now
	pulse.now = () => now
	try {
		app.onEvent(snapshot())
		let first = placeholders.general[0]!
		expect(appView.view().placeholder?.text).toBe(first)
		type('hi')
		let ex = appView.view().placeholder!
		expect(ex.fade).toBe('left')
		expect(ex.cut + ex.text).toBe(first)
		expect(strings.visLen(ex.cut)).toBeGreaterThan(2)
		now += 5 * first.length
		expect(appView.view().placeholder).toBeUndefined()
	} finally {
		pulse.now = saved
	}
})
