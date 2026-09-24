import { expect, test } from 'bun:test'
import { webShortcuts } from './shortcuts.ts'

function key(key: string, extra: Record<string, unknown> = {}): KeyboardEvent {
	return { key, code: `Digit${key}`, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...extra } as KeyboardEvent
}

test('web tab shortcuts mirror the terminal and leave native keys alone', () => {
	expect(webShortcuts.action(key('t', { ctrlKey: true }))).toBe('open')
	expect(webShortcuts.action(key('T', { ctrlKey: true, shiftKey: true }))).toBe('resume')
	expect(webShortcuts.action(key('f', { ctrlKey: true }))).toBe('fork')
	expect(webShortcuts.action(key('n', { ctrlKey: true }))).toBe('next')
	expect(webShortcuts.action(key('p', { ctrlKey: true }))).toBe('prev')
	expect(webShortcuts.action(key('w', { ctrlKey: true }))).toBe('close')
	expect(webShortcuts.action(key('q', { ctrlKey: true }))).toBe('run-next-from-queue')
	expect(webShortcuts.action(key('¡', { code: 'Digit1', altKey: true }))).toBe(1)
	expect(webShortcuts.action(key('0', { altKey: true }))).toBe(10)
	expect(webShortcuts.action(key('f', { metaKey: true }))).toBeNull()
	expect(webShortcuts.action(key('f', { ctrlKey: true, isComposing: true }))).toBeNull()
})
