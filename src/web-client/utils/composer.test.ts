import { describe, expect, test } from 'bun:test'
import { enterAction, pastedImage, sendLabel, submissionCommand } from './composer.ts'

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

describe('pastedImage', () => {
	test('returns the first pasted image and leaves ordinary text alone', () => {
		const image = { type: 'image/png', value: 'image' }
		const text = { type: 'text/plain', value: 'text' }
		expect(pastedImage([{ type: text.type, getAsFile: () => text }, { type: image.type, getAsFile: () => image }])).toBe(image)
		expect(pastedImage([{ type: text.type, getAsFile: () => text }])).toBeNull()
	})
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
