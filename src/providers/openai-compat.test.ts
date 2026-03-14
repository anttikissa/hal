import { describe, it, expect } from 'bun:test'
import { openaiCompat } from './openai-compat.ts'

const { convertMessages, convertTools } = openaiCompat

describe('convertMessages', () => {
	it('converts simple user text', () => {
		const out = convertMessages([{ role: 'user', content: 'hello' }])
		expect(out).toEqual([{ role: 'user', content: 'hello' }])
	})

	it('converts simple assistant text', () => {
		const out = convertMessages([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }])
		expect(out).toEqual([{ role: 'assistant', content: 'hi' }])
	})

	it('converts tool_use to tool_calls', () => {
		const out = convertMessages([{
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Let me check.' },
				{ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
			],
		}])
		expect(out).toEqual([{
			role: 'assistant',
			content: 'Let me check.',
			tool_calls: [{
				id: 'call_1',
				type: 'function',
				function: { name: 'bash', arguments: '{"command":"ls"}' },
			}],
		}])
	})

	it('converts tool_result to tool role', () => {
		const out = convertMessages([{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file.txt' }],
		}])
		expect(out).toEqual([{
			role: 'tool',
			tool_call_id: 'call_1',
			content: 'file.txt',
		}])
	})

	it('handles mixed tool_result and text in user message', () => {
		const out = convertMessages([{
			role: 'user',
			content: [
				{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
				{ type: 'text', text: 'now do X' },
			],
		}])
		expect(out).toEqual([
			{ role: 'tool', tool_call_id: 'call_1', content: 'ok' },
			{ role: 'user', content: 'now do X' },
		])
	})

	it('skips thinking blocks', () => {
		const out = convertMessages([{
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'hmm', signature: 'sig' },
				{ type: 'text', text: 'answer' },
			],
		}])
		expect(out).toEqual([{ role: 'assistant', content: 'answer' }])
	})

	it('converts base64 images to data URLs', () => {
		const out = convertMessages([{
			role: 'user',
			content: [
				{ type: 'text', text: 'what is this?' },
				{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
			],
		}])
		expect(out).toEqual([{
			role: 'user',
			content: [
				{ type: 'text', text: 'what is this?' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
			],
		}])
	})
})

describe('convertTools', () => {
	it('converts Anthropic tool format to OpenAI function format', () => {
		const tools = [{
			name: 'bash',
			description: 'Run a command',
			input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
		}]
		expect(convertTools(tools)).toEqual([{
			type: 'function',
			function: {
				name: 'bash',
				description: 'Run a command',
				parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
			},
		}])
	})
})
