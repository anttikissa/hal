import { expect, test } from 'bun:test'
import { helpBar } from './help-bar.ts'

test('text entry hints show send newline and queue together', () => {
	const text = helpBar.build(false, true)

	expect(text).toContain('enter: send')
	expect(text).toContain('shift-enter: newline')
	expect(text).toContain('alt-enter: queue')
})

test('working text hints keep steer and queue adjacent', () => {
	const text = helpBar.build(true, true)

	const hints = text.split(', ')
	expect(hints.indexOf('alt-enter: queue')).toBe(hints.indexOf('enter: steer') + 1)
})
