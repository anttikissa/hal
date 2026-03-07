// Mock provider — simulates a full agent with thinking, text, tool calls.
// Use with model: mock/mock-1

import type { Provider, ProviderEvent, GenerateParams } from './provider.ts'

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms))
}

const GREETINGS = [
	'Hello! What shall we build today? Say **help** for help.',
	'Hey there! What are we working on? Say **help** for help.',
	'Hi! Ready when you are. Say **help** for help.',
	'Good to see you. What\'s the plan? Say **help** for help.',
]

const THINKING_PHRASES = [
	'Let me think about this...',
	'Analyzing the request...',
	'Considering the options...',
	'Breaking this down...',
]

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]
}

function lastUserText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m.role !== 'user') continue
		if (typeof m.content === 'string') return m.content.trim()
		if (Array.isArray(m.content)) {
			const t = m.content.find((b: any) => b.type === 'text')
			if (t) return t.text.trim()
		}
	}
	return ''
}

function isToolResult(messages: any[]): boolean {
	const last = messages[messages.length - 1]
	return last?.role === 'user' && Array.isArray(last.content) &&
		last.content.some((c: any) => c.type === 'tool_result')
}

async function* streamText(text: string, delayMs = 15): AsyncGenerator<ProviderEvent> {
	for (const ch of text) {
		yield { type: 'text', text: ch }
		await sleep(delayMs)
	}
}

async function* streamChunks(chunks: string[], delayMs = 30): AsyncGenerator<ProviderEvent> {
	for (const chunk of chunks) {
		yield { type: 'text', text: chunk }
		await sleep(delayMs)
	}
}

async function* generate(params: GenerateParams): AsyncGenerator<ProviderEvent> {
	const input = lastUserText(params.messages)
	const lower = input.toLowerCase()
	const tokenCount = input.split(/\s+/).length

	// Tool result follow-up
	if (isToolResult(params.messages)) {
		yield { type: 'thinking', text: 'Looking at the tool output...' }
		await sleep(100)
		yield* streamChunks([
			'Done! ', 'The command ', 'finished ', 'successfully. ',
			'Here\'s what I observed from the output.',
		])
		yield { type: 'done', usage: { input: tokenCount, output: 20 } }
		return
	}

	// First message in conversation → greeting with help
	const userMessages = params.messages.filter((m: any) => m.role === 'user')
	if (userMessages.length <= 1 && (!input || lower === 'hi' || lower === 'hello')) {
		const help = pick(GREETINGS) + '\n\n' +
			'Try: **tool**, **bash <cmd>**, **read <file>**, **write <file> <text>**, ' +
			'**think**, **spam**, **error**'
		yield* streamChunks(help.split(/(?<=\s)/), 25)
		yield { type: 'done', usage: { input: tokenCount, output: help.length } }
		return
	}

	// Keyword-triggered responses
	if (lower === 'help') {
		const help =
			'**Commands:**\n' +
			'- **tool** — trigger a mock tool call\n' +
			'- **bash <cmd>** — mock running a shell command\n' +
			'- **read <file>** — mock reading a file\n' +
			'- **write <file> <text>** — mock writing a file\n' +
			'- **think** — extended thinking demo\n' +
			'- **spam** / **spammm** — wall of text (more m\'s = more lines)\n' +
			'- **error** — trigger an error'
		yield* streamChunks(help.split(/(?<=\n)/), 20)
		yield { type: 'done', usage: { input: tokenCount, output: help.length } }
		return
	}

	if (lower.startsWith('tool') || lower.startsWith('bash ')) {
		const cmd = lower.startsWith('bash ') ? input.slice(5) : 'echo "hello from mock tool"'
		yield { type: 'thinking', text: 'I need to run a command for this.' }
		await sleep(150)
		yield* streamChunks(['Let me run that command.\n'])
		yield { type: 'tool_call', id: 'mock_tool_1', name: 'bash', input: { command: cmd } }
		yield { type: 'done', usage: { input: tokenCount, output: 30 } }
		return
	}

	if (lower.startsWith('read ')) {
		const filename = input.slice(5).trim() || 'README.md'
		yield { type: 'thinking', text: `I'll read ${filename} for you.` }
		await sleep(100)
		yield* streamChunks([`Let me read \`${filename}\`.\n`])
		yield { type: 'tool_call', id: 'mock_read_1', name: 'read', input: { path: filename } }
		yield { type: 'done', usage: { input: tokenCount, output: 20 } }
		return
	}

	if (lower.startsWith('write ')) {
		const parts = input.slice(6).trim().split(/\s+/)
		const filename = parts[0] || 'test.txt'
		const content = parts.slice(1).join(' ') || 'Hello from mock provider!'
		yield { type: 'thinking', text: `Writing to ${filename}.` }
		await sleep(100)
		yield* streamChunks([`I'll create \`${filename}\` for you.\n`])
		yield { type: 'tool_call', id: 'mock_write_1', name: 'write', input: { path: filename, content } }
		yield { type: 'done', usage: { input: tokenCount, output: 25 } }
		return
	}

	if (lower.startsWith('think')) {
		yield { type: 'thinking', text: 'This is a complex problem. Let me reason through it step by step.\n\n' }
		await sleep(200)
		yield { type: 'thinking', text: 'First, I need to consider the constraints.\n' }
		await sleep(200)
		yield { type: 'thinking', text: 'Then, I should evaluate the tradeoffs.\n' }
		await sleep(200)
		yield { type: 'thinking', text: 'Finally, I\'ll synthesize a recommendation.\n' }
		await sleep(200)
		yield* streamChunks([
			'After careful analysis, ', 'I\'ve concluded that ', 'the best approach ',
			'is to keep things simple ', 'and iterate from there. ',
			'Here are my recommendations:\n\n',
			'1. Start small\n', '2. Test early\n', '3. Ship often\n',
		], 40)
		yield { type: 'done', usage: { input: tokenCount, output: 80 } }
		return
	}

	if (lower.startsWith('error')) {
		yield { type: 'thinking', text: 'Processing...' }
		await sleep(100)
		yield { type: 'error', message: 'Mock error: something went wrong (as requested)' }
		yield { type: 'done', usage: { input: tokenCount, output: 0 } }
		return
	}

	const spamMatch = lower.match(/^spa(m+)$/)
	if (spamMatch) {
		// More m's = more lines (each m = 30 lines)
		const count = spamMatch[1].length * 30
		yield { type: 'thinking', text: 'Generating a wall of text...' }
		await sleep(100)
		const lines: string[] = []
		for (let i = 1; i <= count; i++) {
			lines.push(`Line ${i}: ${'lorem ipsum dolor sit amet '.repeat(3).trim()}\n`)
		}
		yield* streamChunks(lines, 10)
		yield { type: 'done', usage: { input: tokenCount, output: count * 10 } }
		return
	}

	// Default: thinking + echo response
	yield { type: 'thinking', text: pick(THINKING_PHRASES) }
	await sleep(150)

	const words = input.split(/\s+/)
	const response = `You said: "${input}" (${words.length} word${words.length === 1 ? '' : 's'}).`
	yield* streamChunks(response.split(/(?<=\s)/), 20)
	yield { type: 'done', usage: { input: tokenCount, output: response.length } }
}

const provider: Provider = { name: 'mock', generate }
export default provider
