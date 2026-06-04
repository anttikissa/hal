import { expect, test } from 'bun:test'
import { continuation } from './continuation.ts'

test('command errors are not retryable', () => {
	const tab = { history: [{ type: 'error', text: 'Name may contain letters only.', retryable: false }] }

	expect(continuation.actionForTab(tab, false)).toBe(false)
})

test('provider errors remain retryable by default', () => {
	const tab = { history: [{ type: 'error', text: '503:\noverloaded' }] }

	expect(continuation.actionForTab(tab, false)).toBe('retry')
})


test('working retryable error has no continue action', () => {
	const tab = { history: [{ type: 'error', text: 'Stream read timed out' }] }

	expect(continuation.actionForTab(tab, true)).toBe(false)
})
