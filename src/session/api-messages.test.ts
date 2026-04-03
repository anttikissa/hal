import { expect, test } from 'bun:test'
import { apiMessages } from './api-messages.ts'

test('formatLocalTime returns HH:MM in local time', () => {
	const result = apiMessages.formatLocalTime('2026-03-28T20:03:39.833Z')
	// Should be a HH:MM string (exact value depends on system timezone)
	expect(result).toMatch(/^\d{2}:\d{2}$/)
})

test('formatLocalTime returns null for missing/invalid input', () => {
	expect(apiMessages.formatLocalTime(undefined)).toBeNull()
	expect(apiMessages.formatLocalTime('')).toBeNull()
	expect(apiMessages.formatLocalTime('not-a-date')).toBeNull()
})

test('compact entry with summary injects context at replay start', () => {
	// History: some old messages, then a compact with summary, then new messages
	const entries = [
		{ role: 'user', content: 'old message 1', ts: '2026-01-01T00:00:00Z' },
		{ role: 'assistant', text: 'old response 1', ts: '2026-01-01T00:01:00Z' },
		{ type: 'compact', summary: 'User asked about X. Assistant explained Y.', ts: '2026-01-01T00:02:00Z' },
		{ role: 'user', content: 'new question after compact', ts: '2026-01-01T00:03:00Z' },
	]

	const msgs = apiMessages.toAnthropicMessages('test-session', entries as any)

	// Should have 3 messages: summary user, summary assistant ack, then new question
	expect(msgs.length).toBe(3)

	// First message should be the injected summary
	expect(msgs[0]!.role).toBe('user')
	expect(msgs[0]!.content).toContain('User asked about X. Assistant explained Y.')

	// Second message should be the assistant acknowledgment
	expect(msgs[1]!.role).toBe('assistant')

	// Third message should be the actual new question
	expect(msgs[2]!.role).toBe('user')
})

test('compact entry without summary just resets (no injection)', () => {
	const entries = [
		{ role: 'user', content: 'old message', ts: '2026-01-01T00:00:00Z' },
		{ role: 'assistant', text: 'old response', ts: '2026-01-01T00:01:00Z' },
		{ type: 'compact', ts: '2026-01-01T00:02:00Z' },
		{ role: 'user', content: 'fresh start', ts: '2026-01-01T00:03:00Z' },
	]

	const msgs = apiMessages.toAnthropicMessages('test-session', entries as any)

	// Should only have the new message after compact
	expect(msgs.length).toBe(1)
	expect(msgs[0]!.role).toBe('user')
})

test('compact with summary but no messages after works', () => {
	// Edge case: user compacted but hasn't sent anything yet
	const entries = [
		{ role: 'user', content: 'old message', ts: '2026-01-01T00:00:00Z' },
		{ role: 'assistant', text: 'old response', ts: '2026-01-01T00:01:00Z' },
		{ type: 'compact', summary: 'Discussed topic Z.', ts: '2026-01-01T00:02:00Z' },
	]

	const msgs = apiMessages.toAnthropicMessages('test-session', entries as any)

	// Should have the summary pair only
	expect(msgs.length).toBe(2)
	expect(msgs[0]!.role).toBe('user')
	expect(msgs[0]!.content).toContain('Discussed topic Z.')
	expect(msgs[1]!.role).toBe('assistant')
})
