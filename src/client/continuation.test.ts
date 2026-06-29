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

test('skips incidental logs and command errors to resume a failed turn', () => {
	// A 401 turn failed, then the user fixed login (a /login typo + login logs).
	// Enter should still resume the underlying retryable turn.
	const tab = {
		history: [
			{ type: 'error', text: '401:\nAnthropic login expired' },
			{ type: 'error', text: '/login: Usage: /login <anthropic|openai> [code]', retryable: false },
			{ type: 'log', text: 'Open this URL to log in to Claude:' },
			{ type: 'log', text: 'Logged in to Claude as user@example.com.' },
		],
	}

	expect(continuation.actionForTab(tab, false)).toBe('retry')
})
