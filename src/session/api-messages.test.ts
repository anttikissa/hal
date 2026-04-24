import { expect, test } from 'bun:test'
import type { Message } from '../protocol.ts'
import { apiMessages } from './api-messages.ts'

test('formatLocalTime returns "Mon DD HH:MM" in local time', () => {
	const result = apiMessages.formatLocalTime('2026-03-28T20:03:39.833Z')
	// Should be "Mon DD HH:MM" string (exact value depends on system timezone)
	expect(result).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}$/)
})

test('formatLocalTime returns null for missing/invalid input', () => {
	expect(apiMessages.formatLocalTime(undefined)).toBeNull()
	expect(apiMessages.formatLocalTime('')).toBeNull()
	expect(apiMessages.formatLocalTime('not-a-date')).toBeNull()
})

test('pruneMessages batches heavy pruning by completed turns', () => {
	const prev = {
		heavyThreshold: apiMessages.config.heavyThreshold,
		thinkingThreshold: apiMessages.config.thinkingThreshold,
		pruneBatchTurns: apiMessages.config.pruneBatchTurns,
	}
	apiMessages.config.heavyThreshold = 0
	apiMessages.config.thinkingThreshold = 99
	apiMessages.config.pruneBatchTurns = 2
	try {
		const beforeBatch: Message[] = [
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'a.ts' } }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'alpha' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
		]
		const afterBatch: Message[] = [
			...beforeBatch,
			{ role: 'user', content: 'next' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done again' }] },
		]
		expect(apiMessages.pruneMessages(beforeBatch)).toEqual(beforeBatch)
		expect(apiMessages.pruneMessages(afterBatch)).toEqual([
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: {} }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '[tool result omitted from context]' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
			{ role: 'user', content: 'next' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done again' }] },
		])
	} finally {
		apiMessages.config.heavyThreshold = prev.heavyThreshold
		apiMessages.config.thinkingThreshold = prev.thinkingThreshold
		apiMessages.config.pruneBatchTurns = prev.pruneBatchTurns
	}
})

test('pruneMessages batches thinking pruning too', () => {
	const prev = {
		heavyThreshold: apiMessages.config.heavyThreshold,
		thinkingThreshold: apiMessages.config.thinkingThreshold,
		pruneBatchTurns: apiMessages.config.pruneBatchTurns,
	}
	apiMessages.config.heavyThreshold = 99
	apiMessages.config.thinkingThreshold = 0
	apiMessages.config.pruneBatchTurns = 2
	try {
		const beforeBatch: Message[] = [
			{ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'sig' }, { type: 'text', text: 'answer' }] },
		]
		const afterBatch: Message[] = [
			...beforeBatch,
			{ role: 'user', content: 'next' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
			{ role: 'user', content: 'next 2' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done 2' }] },
		]
		expect(apiMessages.pruneMessages(beforeBatch)).toEqual(beforeBatch)
		expect(apiMessages.pruneMessages(afterBatch)).toEqual([
			{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
			{ role: 'user', content: 'next' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
			{ role: 'user', content: 'next 2' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done 2' }] },
		])
	} finally {
		apiMessages.config.heavyThreshold = prev.heavyThreshold
		apiMessages.config.thinkingThreshold = prev.thinkingThreshold
		apiMessages.config.pruneBatchTurns = prev.pruneBatchTurns
	}
})


test('toProviderMessages merges assistant chunks split by ui info', () => {
	const ts = '2026-04-13T14:43:49.970Z'
	const entries: any[] = [
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts },
		{ type: 'assistant', text: 'this is me typing ', id: 'xyz-123', ts },
		{ type: 'info', text: 'system.md was reloaded', ts },
		{ type: 'assistant', text: 'and still typing', continue: 'xyz-123', ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[13 Apr 14:43]\nhello' },
		{ role: 'assistant', content: [
			{ type: 'text', text: 'this is me typing ' },
			{ type: 'text', text: 'and still typing' },
		] },
	])
})


test('toProviderMessages wraps next-user info in meta tags', () => {
	const ts = '2026-04-13T14:43:49.970Z'
	const entries: any[] = [
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts },
		{ type: 'assistant', text: 'hello there', ts },
		{ type: 'info', text: 'cwd changed from /tmp to /Users/antti/.hal', visibility: 'next-user', ts },
		{ type: 'user', parts: [{ type: 'text', text: 'what now?' }], ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[13 Apr 14:43]\nhello' },
		{ role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
		{ role: 'user', content: '[13 Apr 14:43]\n<meta>cwd changed from /tmp to /Users/antti/.hal</meta>\nwhat now?' },
	])
})


test('toProviderMessages wraps synthetic assistant messages in synthetic tags', () => {
	const ts = '2026-04-13T14:43:49.970Z'
	const entries: any[] = [
		{ type: 'assistant', text: 'Howdy! What shall we do today?', synthetic: true, syntheticKind: 'greeting', ts },
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'assistant', content: [{ type: 'text', text: '<synthetic>Howdy! What shall we do today?</synthetic>' }] },
		{ role: 'user', content: '[13 Apr 14:43]\nhello' },
	])
})

test('toProviderMessages starts after the last reset marker', () => {
	const ts = '2026-04-15T00:00:00.000Z'
	const entries: any[] = [
		{ type: 'user', parts: [{ type: 'text', text: 'old prompt' }], ts },
		{ type: 'assistant', text: 'old answer', ts },
		{ type: 'reset', ts },
		{ type: 'user', parts: [{ type: 'text', text: '[system] Session was reset. Previous conversation: history.asonl' }], ts },
		{ type: 'user', parts: [{ type: 'text', text: 'fresh prompt' }], ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[15 Apr 00:00]\n[system] Session was reset. Previous conversation: history.asonl' },
		{ role: 'user', content: '[15 Apr 00:00]\nfresh prompt' },
	])
})

test('toProviderMessages starts after the last compact marker', () => {
	const ts = '2026-04-15T00:00:00.000Z'
	const entries: any[] = [
		{ type: 'user', parts: [{ type: 'text', text: 'old prompt' }], ts },
		{ type: 'assistant', text: 'old answer', ts },
		{ type: 'compact', ts },
		{ type: 'user', parts: [{ type: 'text', text: '[system] Session was manually compacted. Previous conversation: history.asonl' }], ts },
		{ type: 'user', parts: [{ type: 'text', text: 'Context was compacted to avoid exceeding the token limit. Verify before assuming.' }], ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[15 Apr 00:00]\n[system] Session was manually compacted. Previous conversation: history.asonl' },
		{ role: 'user', content: '[15 Apr 00:00]\nContext was compacted to avoid exceeding the token limit. Verify before assuming.' },
	])
})
