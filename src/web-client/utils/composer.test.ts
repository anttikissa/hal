import { describe, expect, test } from 'bun:test'
import { attachmentRef, enterAction, pastedImage, sendLabel, submissionCommand, typingKey } from './composer.ts'

describe('enterAction', () => {
	test('desktop: Enter submits, Shift+Enter newlines', () => {
		expect(enterAction('Enter', {})).toBe('submit')
		expect(enterAction('Enter', { shift: true })).toBe('newline')
	})

	test('touch keyboard: Enter always newlines, Send button submits', () => {
		expect(enterAction('Enter', { coarse: true })).toBe('newline')
		expect(enterAction('Enter', { shift: true, coarse: true })).toBe('newline')
	})

	test('other keys do nothing', () => {
		expect(enterAction('a', {})).toBe('none')
	})
})

test('Cmd/Ctrl+Enter queues while working, otherwise sends normally', () => {
	expect(enterAction('Enter', { meta: true, working: true })).toBe('queue')
	expect(enterAction('Enter', { ctrl: true, working: true })).toBe('queue')
	expect(enterAction('Enter', { meta: true, working: false })).toBe('submit')
	expect(enterAction('Enter', { meta: true, shift: true, working: true })).toBe('newline')
})

test('typingKey only redirects printable unmodified keystrokes', () => {
	const event = (key: string, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...modifiers }) as KeyboardEvent
	expect(typingKey(event('a'))).toBe(true)
	expect(typingKey(event(' '))).toBe(true)
	expect(typingKey(event('😀'))).toBe(true)
	for (const key of ['Enter', 'Tab', 'Escape', 'Dead']) expect(typingKey(event(key))).toBe(false)
	for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
		expect(typingKey(event('a', modifiers))).toBe(false)
	}
})

describe('pastedImage', () => {
	test('returns the first pasted image and leaves ordinary text alone', () => {
		const image = { type: 'image/png', value: 'image' }
		const text = { type: 'text/plain', value: 'text' }
		expect(pastedImage([{ type: text.type, getAsFile: () => text }, { type: image.type, getAsFile: () => image }])).toBe(image)
		expect(pastedImage([{ type: text.type, getAsFile: () => text }])).toBeNull()
	})
})

test('attachmentRef adds spacing at the captured insertion point', () => {
	expect(attachmentRef('beforeafter', 6, 'image.png')).toBe(' [image.png] ')
	expect(attachmentRef('before after', 7, 'image.png')).toBe('[image.png] ')
	expect(attachmentRef('', 0, 'image.png')).toBe('[image.png] ')
})

describe('sendLabel', () => {
	test('names what the button will actually do', () => {
		expect(sendLabel(false)).toBe('Send')
		expect(sendLabel(true)).toBe('Steer')
	})
})

describe('submissionCommand', () => {
	test('sends /what through its non-interrupting command channel', () => {
		expect(submissionCommand('/what', '04-work', '000001-abc', false)).toEqual({ type: 'what', sessionId: '04-work', target: '' })
		expect(submissionCommand('/what 2-4', '04-work', '000001-abc', true)).toEqual({ type: 'what', sessionId: '04-work', target: '2-4' })
	})

	test('leaves ordinary prompts and longer slash-command names alone', () => {
		expect(submissionCommand('hello', '04-work', '000001-abc', true)).toEqual({ type: 'prompt', id: '000001-abc', sessionId: '04-work', text: 'hello', source: 'web', queue: true })
		expect(submissionCommand('/whatever', '04-work', '000001-abc', false)).toMatchObject({ type: 'prompt', text: '/whatever' })
	})
})
