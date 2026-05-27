import { expect, test } from 'bun:test'
import { helpBar } from './help-bar.ts'

test('continuable state takes precedence over stale busy state', () => {
	expect(helpBar.deriveState(true, false, 'retry')).toBe('idle-retry')
	expect(helpBar.deriveState(true, false, 'continue')).toBe('idle-continue')
})

test('idle empty hints are prompt-specific', () => {
	const text = helpBar.build(false, false)

	expect(text).toContain('type a prompt')
	expect(text).not.toContain('ctrl-t: new')
	expect(text).not.toContain('/: commands')
})


test('text entry hints show send newline and queue together', () => {
	const text = helpBar.build(false, true)

	expect(text).toContain('enter: send')
	expect(text).toContain('shift-enter: newline')
	expect(text).toContain('alt-enter: queue')
})

test('busy text hints show steer newline queue and pause', () => {
	const text = helpBar.build(true, true)

	expect(text).toContain('enter: steer')
	expect(text).toContain('shift-enter: newline')
	expect(text).toContain('alt-enter: queue')
	expect(text).toContain('esc: pause')
})
