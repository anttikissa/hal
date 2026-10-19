// Slash-command completion in the web message box: host answers, the
// menu, choosing, and Enter running or queueing commands.

import { expect, test } from 'bun:test'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { view } from './view.ts'
import { useApp, fx, message, press, sessionId, snapshot } from './app-fixture.test.ts'

useApp()

test('Tab at the end of a slash command asks the host, and its answer fills the box', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	expect(press('Tab', message('/cd ~/p', 0))).toBe(false)
	expect(press('Tab', message('/cd ~/p'))).toBe(true)
	expect(fx.sent.at(-1)).toMatchObject({ type: 'complete', sessionId, text: '/cd ~/p' })
	app.onEvent({ type: 'completions', sessionId, text: '/cd ~/p', items: ['/cd ~/projects/'] })
	expect(app.state.text).toBe('/cd ~/projects/')
})

test('typing opens host completions; keyboard choice is not sent, stale answers and Escape stay hidden', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	app.input('/c')
	expect(fx.sent).toContainEqual(expect.objectContaining({ type: 'complete', text: '/c' }))
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	expect(app.state.menu?.choices).toHaveLength(2)
	expect(press('ArrowDown', message('/c'))).toBe(true)
	expect(press('Enter', message('/c'))).toBe(true)
	expect(app.state.text).toBe('/clear ')
	expect(app.state.menu).toBeUndefined()
	app.input('/c')
	app.onEvent({ type: 'completions', sessionId, text: '/clear ', items: ['/clear '] })
	expect(app.state.menu).toBeUndefined()
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	expect(press('Escape', message('/c'))).toBe(true)
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	expect(app.state.menu).toBeUndefined()
})

// The answer arrives later than the input event. Repainting an unchanged
// menu between the two is an observable layout jump, not loading feedback.
test('a completion menu remains identical across input and an unchanged host reply', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	app.input('/model gp')
	app.onEvent({
		type: 'completions',
		sessionId,
		text: '/model gp',
		items: ['/model gpt-6.1'],
		descriptions: ['openai/gpt-6.1-sol'],
	})
	let shown = app.state.menu
	expect(shown?.choices[0]?.description).toBe('openai/gpt-6.1-sol')
	app.input('/model gpt')
	expect(app.state.menu).toBe(shown)
	expect(fx.sent.at(-1)).toMatchObject({ type: 'complete', text: '/model gpt' })
	app.onEvent({ type: 'completions', sessionId, text: '/model gp', items: [] })
	expect(app.state.menu).toBe(shown)
	app.onEvent({
		type: 'completions',
		sessionId,
		text: '/model gpt',
		items: ['/model gpt-6.1'],
		descriptions: ['openai/gpt-6.1-sol'],
	})
	expect(app.state.menu).toBe(shown)
})

test('a longer prefix filters known choices without waiting, while a shorter one waits for the full host list', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	app.input('/c')
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	let first = app.state.menu!.choices[0]!
	let clear = app.state.menu!.choices[1]!
	app.input('/cl')
	expect(app.state.menu!.choices).toEqual([clear])
	let filtered = app.state.menu
	app.onEvent({ type: 'completions', sessionId, text: '/cl', items: ['/clear '] })
	expect(app.state.menu).toBe(filtered)
	app.input('/c')
	expect(app.state.menu!.choices).toEqual([clear]) // only the host can supply candidates the shorter prefix adds
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	expect(app.state.menu!.choices).toEqual([first, clear])
	app.input('/clx')
	expect(app.state.menu).toBeUndefined()
})

test('slash commands never queue, including modified Enter; ordinary messages still queue', () => {
	app.onEvent(snapshot({ type: 'running', phase: 'streaming' }))
	for (let text of ['/model other', '  /cd /tmp', '/']) {
		app.input(text)
		expect(press('Enter', message(text), { altKey: true })).toBe(true)
		let submit = fx.sent.findLast((c) => c.type === 'submit')
		expect(submit.text).toBe(text)
		expect(submit.queue).toBeUndefined()
	}
	app.input('/model o')
	app.onEvent({ type: 'completions', sessionId, text: '/model o', items: ['/model other'] })
	expect(view.hints(app.state.view, app.state.text, app.state.menu).some((h) => h[1] === 'queue')).toBe(false)
	for (let text of ['later', '/tmp/file is broken']) {
		app.input(text)
		press('Enter', message(text), { altKey: true })
		expect(fx.sent.findLast((c) => c.type === 'submit')).toMatchObject({ text, delivery: 'queue' })
	}
})

test('exact registered commands submit their typed arguments, never passive candidates', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	for (let text of ['/cd', '/cd /existing', '/cd /missing', '/model other']) {
		for (let items of [undefined, [text + '-candidate/'], []]) {
			app.input(text)
			if (items) app.onEvent({ type: 'completions', sessionId, text, items })
			expect(press('Enter', message(text))).toBe(true)
			expect(fx.sent.filter((c) => c.type === 'submit').at(-1)).toMatchObject({ text })
			expect(app.state.text).toBe('')
		}
	}
})

test('partial Enter chooses; explicit arrows override exact commands until the next edit', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	app.input('/c')
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	expect(view.hints(app.state.view, app.state.text, app.state.menu)[0]).toEqual(['enter', 'choose'])
	expect(press('Enter', message('/c'))).toBe(true)
	expect(app.state.text).toBe('/cd ')
	app.input('/cd /p')
	let answer: Event = { type: 'completions', sessionId, text: '/cd /p', items: ['/cd /projects/', '/cd /private/'] }
	app.onEvent(answer)
	press('ArrowDown', message('/cd /p'))
	app.onEvent(answer) // a reply must preserve deliberate navigation
	press('Enter', message('/cd /p'))
	expect(app.state.text).toBe('/cd /private/')
	expect(fx.sent.some((c) => c.type === 'submit')).toBe(false)
	app.input('/cd /p')
	app.onEvent(answer)
	press('ArrowUp', message('/cd /p'))
	app.input('/cd /pr') // same candidate array after prediction: reset intent anyway
	app.onEvent({ ...answer, text: '/cd /pr' })
	expect(view.hints(app.state.view, app.state.text, app.state.menu)[0]).toEqual(['enter', 'run'])
	press('Enter', message('/cd /pr'))
	expect(fx.sent.some((c) => c.type === 'submit' && c.text === '/cd /pr')).toBe(true)
})

test('dismissal suppresses pending completions; Escape outside never pauses as well', () => {
	app.onEvent(snapshot({ type: 'running', phase: 'streaming' }))
	app.input('/c')
	app.dismissMenu()
	let answer: Event = { type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] }
	app.onEvent(answer)
	expect(app.state.menu).toBeUndefined()
	expect(app.state.text).toBe('/c')
	app.input('/cl')
	app.input('/c')
	app.onEvent(answer)
	expect(app.state.menu).toBeDefined()
	expect(press('Escape', { kind: 'other' })).toBe(true)
	expect(fx.sent.some((c) => c.type === 'pause')).toBe(false)
	app.onEvent(answer)
	expect(app.state.menu).toBeUndefined()
})

test('an open menu preserves touch and modified Enter and Tab contracts', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	app.input('/c')
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	expect(press('Enter', { kind: 'message', text: '/c', cursor: 2, coarse: true })).toBe(false)
	expect(press('Enter', message('/c'), { shiftKey: true })).toBe(false)
	expect(app.state.text).toBe('/c')
	expect(press('Tab', message('/c'))).toBe(true)
	expect(app.state.text).toBe('/c') // no unambiguous extension
	press('ArrowDown', message('/c'))
	press('Tab', message('/c'))
	expect(app.state.text).toBe('/clear ')
	app.input('/cd')
	app.onEvent({ type: 'completions', sessionId, text: '/cd', items: ['/cd /suggestion/'] })
	press('Enter', message('/cd'), { altKey: true })
	expect(fx.sent.some((c) => c.type === 'submit' && c.text === '/cd')).toBe(true)
})
