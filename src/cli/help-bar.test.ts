import { expect, test } from 'bun:test'
import { helpBar } from './help-bar.ts'

test('working state hides stale continue actions', () => {
	expect(helpBar.deriveState(true, false, 'retry')).toBe('working')
	expect(helpBar.deriveState(true, false, 'continue')).toBe('working')
})
test('text entry hints show send and option-enter newline together', () => {
	const text = helpBar.build(false, true)

	expect(text).toContain('enter: send')
	expect(text).toContain('shift/option-enter: newline')
	expect(text).not.toContain('queue')
})


test('restore tab hint is formatted like shortcut hints', () => {
	const text = helpBar.restoreTabHint()

	expect(text).toBe('ctrl-shift-t: restore tab')
})

test('working text hints keep steer and newline adjacent', () => {
	const text = helpBar.build(true, true)

	expect(text).toBe('enter: steer, shift/option-enter: newline, esc: pause')
})
