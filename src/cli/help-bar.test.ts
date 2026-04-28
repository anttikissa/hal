import { expect, test } from 'bun:test'
import { helpBar } from './help-bar.ts'

test('continuable state takes precedence over stale busy state', () => {
	expect(helpBar.deriveState(true, false, 'retry')).toBe('idle-retry')
	expect(helpBar.deriveState(true, false, 'continue')).toBe('idle-continue')
})
