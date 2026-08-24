import { describe, expect, test } from 'bun:test'
import { enterAction, sendLabel } from './composer.ts'

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

describe('sendLabel', () => {
	test('names what the button will actually do', () => {
		expect(sendLabel(false)).toBe('Send')
		expect(sendLabel(true)).toBe('Steer')
	})
})
