import { describe, test, expect } from 'bun:test'
import { formatMessagesForHandoff, windowConversationText } from './handle-command.ts'

describe('formatMessagesForHandoff', () => {
	test('formats simple text messages', () => {
		const messages = [
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
		]
		const result = formatMessagesForHandoff(messages)
		expect(result).toContain('[user]\nhello')
		expect(result).toContain('[assistant]\nhi there')
		expect(result).toContain('---')
	})

	test('strips thinking blocks', () => {
		const messages = [
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Let me think about this very carefully...' },
					{ type: 'text', text: 'Here is my answer' },
				],
			},
		]
		const result = formatMessagesForHandoff(messages)
		expect(result).not.toContain('thinking')
		expect(result).toContain('Here is my answer')
	})

	test('truncates large tool results', () => {
		const bigResult = 'x'.repeat(1000)
		const messages = [
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 't1', content: bigResult }],
			},
		]
		const result = formatMessagesForHandoff(messages)
		expect(result.length).toBeLessThan(bigResult.length)
		expect(result).toContain('…')
	})

	test('preserves small tool results in full', () => {
		const smallResult = 'ok done'
		const messages = [
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 't1', content: smallResult }],
			},
		]
		const result = formatMessagesForHandoff(messages)
		expect(result).toContain('[result] ok done')
		expect(result).not.toContain('…')
	})

	test('formats tool_use blocks', () => {
		const messages = [
			{
				role: 'assistant',
				content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }],
			},
		]
		const result = formatMessagesForHandoff(messages)
		expect(result).toContain('[tool: bash]')
		expect(result).toContain('"command":"ls"')
	})
})

describe('windowConversationText', () => {
	test('returns short text unchanged', () => {
		const text = 'short conversation'
		expect(windowConversationText(text)).toBe(text)
	})

	test('windows long text with head + tail + marker', () => {
		// Create text longer than MAX_CONVERSATION_CHARS (300K)
		const text = 'A'.repeat(100_000) + 'MIDDLE' + 'Z'.repeat(250_000)
		const result = windowConversationText(text)
		expect(result.length).toBeLessThan(text.length)
		expect(result).toContain('omitted')
		// Head is preserved
		expect(result.startsWith('A')).toBe(true)
		// Tail is preserved
		expect(result.endsWith('Z')).toBe(true)
	})
})
