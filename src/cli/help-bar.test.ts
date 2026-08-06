import { expect, test } from 'bun:test'
import { helpBar } from './help-bar.ts'

test('working state hides stale continue actions', () => {
	expect(helpBar.deriveState(true, false, 'retry')).toBe('working')
	expect(helpBar.deriveState(true, false, 'continue')).toBe('working')
})
test('text entry hints show send newline and queue together', () => {
	const text = helpBar.build(false, true)

	expect(text).toContain('enter: send')
	expect(text).toContain('shift-enter: newline')
	expect(text).toContain('alt-enter: queue')
})


test('restore tab hint is formatted like shortcut hints', () => {
	const text = helpBar.restoreTabHint()

	expect(text).toBe('ctrl-shift-t: restore tab')
})

test('working text hints keep steer and queue adjacent', () => {
	const text = helpBar.build(true, true)

	expect(text).toBe('enter: steer, alt-enter: queue, shift-enter: newline, esc: pause')
})
