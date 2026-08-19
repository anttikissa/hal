import { expect, test } from 'bun:test'
import type { Message } from '../../common/protocol.ts'
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
		{ type: 'assistant', text: 'this is me typing ', ts },
		{ type: 'info', text: 'system.md was reloaded', ts },
		{ type: 'assistant', text: 'and still typing', ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[13 Apr 14:43]\nhello' },
		{ role: 'assistant', content: [
			{ type: 'text', text: 'this is me typing ' },
			{ type: 'text', text: 'and still typing' },
		] },
	])
})


test('toProviderMessages skips canceled history entries', () => {
	const ts = '2026-04-13T14:43:49.970Z'
	const entries: any[] = [
		{ type: 'user', parts: [{ type: 'text', text: 'old prompt' }], canceled: true, ts },
		{ type: 'assistant', text: 'old partial', canceled: true, ts },
		{ type: 'user', parts: [{ type: 'text', text: 'new prompt' }], ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[13 Apr 14:43]\nnew prompt' },
	])
})


test('toProviderMessages wraps next-user info in meta tags', () => {
	const ts = '2026-04-13T14:43:49.970Z'
	const entries: any[] = [
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts },
		{ type: 'assistant', text: 'hello there', ts },
		{ type: 'info', text: 'cwd changed from /tmp to /home/user/.hal', visibility: 'next-user', ts },
		{ type: 'user', parts: [{ type: 'text', text: 'what now?' }], ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[13 Apr 14:43]\nhello' },
		{ role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
		{ role: 'user', content: '[13 Apr 14:43]\n<meta>cwd changed from /tmp to /home/user/.hal</meta>\nwhat now?' },
	])
})


test('toProviderMessages wraps structural next-user state in meta tags', () => {
	const ts = '2026-04-13T14:43:49.970Z'
	const entries: any[] = [
		{ type: 'cwd', from: '/tmp', to: '/home/user/.hal', visibility: 'next-user', ts },
		{ type: 'model', from: 'openai/gpt-5.4', to: 'openai/gpt-5.5', visibility: 'next-user', ts },
		{ type: 'forked_from', parent: '114-mad', ts },
		{ type: 'forked_to', child: '116-see', ts },
		{ type: 'user', parts: [{ type: 'text', text: 'what now?' }], ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[13 Apr 14:43]\n<meta>cwd changed from /tmp to /home/user/.hal</meta>\n<meta>model changed from openai/gpt-5.4 to openai/gpt-5.5</meta>\n<meta>session forked from 114-mad</meta>\n<meta>session forked to 116-see</meta>\nwhat now?' },
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


test('toProviderMessages skips ui-only assistant messages', () => {
	const ts = '2026-04-13T14:43:49.970Z'
	const entries: any[] = [
		{ type: 'assistant', text: 'What summary', synthetic: true, syntheticKind: 'what-summary', visibility: 'ui', ts },
		{ type: 'info', text: 'User ran /what for session 04-one.', visibility: 'next-user', ts },
		{ type: 'user', parts: [{ type: 'text', text: 'continue' }], ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[13 Apr 14:43]\n<meta>User ran /what for session 04-one.</meta>\ncontinue' },
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


test('toProviderMessages retains a fork marker immediately before reset', () => {
	const ts = '2026-04-15T00:00:00.000Z'
	const entries: any[] = [
		{ type: 'forked_from', parent: '114-mad', ts },
		{ type: 'reset', ts },
		{ type: 'user', parts: [{ type: 'text', text: 'fresh prompt' }], ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'user', content: '[15 Apr 00:00]\n<meta>session forked from 114-mad</meta>\nfresh prompt' },
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


test('unmatched non-pending tool calls still repair to interrupted result', () => {
	const ts = '2026-04-15T00:00:00.000Z'
	const entries: any[] = [
		{ type: 'tool_call', toolId: 'tool-1', name: 'read', input: { path: 'README.md' }, ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'README.md' } }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '[interrupted]' }] },
	])
})


test('unresolved pending tools guard against provider replay before execution', () => {
	const ts = '2026-04-15T00:00:00.000Z'
	const entries: any[] = [
		{ type: 'tool_call', toolId: 'tool-1', name: 'read', input: { path: 'README.md' }, ts },
		{ type: 'pending_tools', toolIds: ['tool-1'], cwd: '/tmp/work', reason: 'soft-pause', ts },
	]

	expect(() => apiMessages.toProviderMessages('test-session', entries, { prune: false })).toThrow('pending tools')
})


test('resolved pending tools markers are ignored during provider replay', () => {
	const ts = '2026-04-15T00:00:00.000Z'
	const entries: any[] = [
		{ type: 'tool_call', toolId: 'tool-1', name: 'read', input: { path: 'README.md' }, ts },
		{ type: 'pending_tools', toolIds: ['tool-1'], cwd: '/tmp/work', reason: 'soft-pause', canceled: true, ts },
		{ type: 'tool_result', toolId: 'tool-1', output: 'ok', ts },
	]

	expect(apiMessages.toProviderMessages('test-session', entries, { prune: false })).toEqual([
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'README.md' } }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
	])
})

test('repairToolPairing drops tool_result blocks with no matching tool_use', () => {
	const msgs: Message[] = [
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }] },
		{ role: 'user', content: [
			{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
			{ type: 'tool_result', tool_use_id: 'srvtoolu_1', content: '[interrupted]' },
		] },
	]
	apiMessages.repairToolPairing(msgs)
	expect(msgs).toEqual([
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
	])
})
