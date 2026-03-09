import { test, expect, beforeEach } from 'bun:test'
import { handleInput, type InputContext } from './keybindings.ts'
import type { KeyEvent } from './keys.ts'
import * as prompt from './prompt.ts'

const sent: { type: string; text?: string }[] = []
const blocks: any[] = []

function mockCtx(overrides?: Partial<InputContext>): InputContext {
	return {
		send: (type, text) => { sent.push({ type, text }) },
		activeTab: () => ({ blocks, busy: false }),
		tabs: () => [{ sessionId: '01-abc', info: { topic: '.hal', workingDir: '/Users/antti/.hal' } }],
		activeTabIndex: () => 0,
		saveDraft: () => {},
		onSubmit: () => {},
		nextTab: () => {},
		prevTab: () => {},
		switchToTab: () => {},
		clearQuestion: () => {},
		markPausing: () => {},
		doRender: () => {},
		contentWidth: () => 80,
		quit: () => {},
		restart: () => {},
		suspend: () => {},
		...overrides,
	}
}

function ke(key: string, mods?: Partial<KeyEvent>): KeyEvent {
	return { key, char: '', ctrl: false, alt: false, shift: false, cmd: false, ...mods }
}

beforeEach(() => {
	sent.length = 0
	blocks.length = 0
	prompt.reset()
})

test('/help adds a local help block without sending a command', () => {
	const ctx = mockCtx()
	prompt.setText('/help')
	handleInput(ke('enter'), ctx)
	expect(sent).toEqual([])
	expect(blocks.length).toBe(1)
	expect(blocks[0].type).toBe('assistant')
	expect(blocks[0].done).toBe(true)
	expect(blocks[0].text).toContain('/reset')
	expect(blocks[0].text).toContain('/model')
	expect(blocks[0].text).toContain('ctrl-t')
})

test('option+digit switches to tab N (1-indexed)', () => {
	let switched = -1
	const ctx = mockCtx({ switchToTab: (i) => { switched = i } })
	handleInput(ke('3', { alt: true }), ctx)
	expect(switched).toBe(2)
})

test('option+digit does not switch on non-digit', () => {
	let switched = false
	const ctx = mockCtx({ switchToTab: () => { switched = true } })
	handleInput(ke('g', { alt: true }), ctx)
	expect(switched).toBe(false)
})

test('escape sends pause and calls markPausing when active tab is busy', () => {
	let paused = false
	const ctx = mockCtx({
		activeTab: () => ({ blocks, busy: true }),
		markPausing: () => { paused = true },
	})
	handleInput(ke('escape'), ctx)
	expect(sent).toEqual([{ type: 'pause', text: undefined }])
	expect(paused).toBe(true)
})

test('escape does nothing when active tab is not busy', () => {
	const ctx = mockCtx()
	handleInput(ke('escape'), ctx)
	expect(sent).toEqual([])
})

test('ctrl-t sends open', () => {
	let saved = false
	const ctx = mockCtx({ saveDraft: () => { saved = true } })
	handleInput(ke('t', { ctrl: true }), ctx)
	expect(sent).toEqual([{ type: 'open', text: undefined }])
	expect(saved).toBe(true)
})

test('ctrl-f sends fork', () => {
	const ctx = mockCtx()
	handleInput(ke('f', { ctrl: true }), ctx)
	expect(sent).toEqual([{ type: 'fork', text: undefined }])
})

test('typing text and enter sends prompt', () => {
	let submitted = false
	const ctx = mockCtx({ onSubmit: () => { submitted = true } })
	for (const ch of 'hello') prompt.handleKey(ke(ch, { char: ch }), 80)
	handleInput(ke('enter'), ctx)
	expect(sent).toEqual([{ type: 'prompt', text: 'hello' }])
	expect(submitted).toBe(true)
})

test('/resume sends open with id', () => {
	const ctx = mockCtx()
	prompt.setText('/resume 00-abc')
	handleInput(ke('enter'), ctx)
	expect(sent).toEqual([{ type: 'open', text: '00-abc' }])
})

test('/reset sends reset command', () => {
	const ctx = mockCtx()
	prompt.setText('/reset')
	handleInput(ke('enter'), ctx)
	expect(sent).toEqual([{ type: 'reset', text: undefined }])
})

test('tab completes /model argument', () => {
	const ctx = mockCtx()
	prompt.setText('/model codex-s')
	handleInput(ke('tab'), ctx)
	expect(prompt.text()).toBe('/model codex-spark ')
})

test('tab completion with multiple matches shows options in output', () => {
	const ctx = mockCtx()
	prompt.setText('/r')
	handleInput(ke('tab'), ctx)
	expect(blocks.some((b) => b.type === 'info' && typeof b.text === 'string' && b.text.includes('/reset') && b.text.includes('/respond') && b.text.includes('/resume'))).toBe(true)
})
