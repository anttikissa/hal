import { describe, test, expect } from 'bun:test'
import { lineEditor } from './line-editor.ts'
import type { KeyEvent } from './keys.ts'

function key(key: string, mods: Partial<KeyEvent> = {}): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}

describe('line editor', () => {
	test('ctrl-a and ctrl-e move to the ends', () => {
		const editor = lineEditor.create('hello')
		editor.handleKey(key('a', { ctrl: true }))
		expect(editor.cursorPos()).toBe(0)
		editor.handleKey(key('e', { ctrl: true }))
		expect(editor.cursorPos()).toBe(5)
	})

	test('shift-left selects text and backspace deletes it', () => {
		const editor = lineEditor.create('hello')
		editor.handleKey(key('left', { shift: true }))
		editor.handleKey(key('left', { shift: true }))
		expect(editor.buildLine().line).toContain('\x1b[7mlo\x1b[0m')
		editor.handleKey(key('backspace'))
		expect(editor.text()).toBe('hel')
		expect(editor.cursorPos()).toBe(3)
	})

	test('cmd-a selects all and typed text replaces it', () => {
		const editor = lineEditor.create('sonnet')
		editor.handleKey(key('a', { cmd: true }))
		editor.handleKey({ key: 'o', char: 'o', shift: false, alt: false, ctrl: false, cmd: false })
		expect(editor.text()).toBe('o')
		expect(editor.cursorPos()).toBe(1)
	})
})
