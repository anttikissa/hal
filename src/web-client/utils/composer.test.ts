import { describe, expect, test } from 'bun:test'
import { enterAction, pastedImage, sendLabel } from './composer.ts'

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
