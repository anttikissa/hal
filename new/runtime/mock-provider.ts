// Mock provider — simulates a full agent with thinking, text, tool calls.
// Use with model: mock/mock-1

import type { Provider, ProviderEvent, GenerateParams } from './provider.ts'

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms))
}

const SPAM_TEXT = `The configuration system uses a layered approach where project-level settings override global defaults, and environment variables take highest priority over everything else in the chain.

Here's what we need to handle:

- **Token limits** need careful tracking across \`streaming\` and \`batch\` modes
- The \`**retry logic**\` should respect both rate limits and \`backoff\` timers
- Lists with **bold items** and \`code spans\` mixed together freely

When the context window fills up, compaction kicks in automatically. It summarizes older messages while preserving the most recent exchanges, tool results, and any pinned context the user marked as important.

## Implementation notes

1. **First pass**: scan all blocks for token counts using \`tiktoken\` estimation
2. **Second pass**: merge adjacent assistant blocks that share the same \`role\`
3. Run the \`**compaction prompt**\` against the oldest N messages
4. Replace originals with the summary, preserving \`tool_call\` and \`tool_result\` pairs

The streaming renderer operates on a simple principle — each block knows how to render itself into terminal lines, and the container joins them with consistent spacing. This avoids the classic problem where different parts of the UI fight over whitespace.

Error handling follows a similar pattern. Rather than wrapping everything in try-catch blocks scattered throughout the codebase, we use a central error boundary that catches unhandled rejections and formats them into error blocks visible in the conversation stream.`

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
		// More m's = more text (each m ≈ 10 lines of paragraphs)
		const targetChars = spamMatch[1].length * 10 * 80
		let corpus = ''
		while (corpus.length < targetChars) corpus += SPAM_TEXT + '\n\n'
		const cut = corpus.indexOf('\n\n', targetChars)
		corpus = cut === -1 ? corpus : corpus.slice(0, cut)

		// Alternate thinking → text segments
		const paragraphs = corpus.split(/\n\n+/)
		let pi = 0
		while (pi < paragraphs.length) {
			// Thinking: 1 paragraph, strip markdown to look like reasoning
			const think = paragraphs[pi].replace(/[#*`\-\d.]/g, '').replace(/  +/g, ' ').trim()
			yield { type: 'thinking', text: think || 'Let me think about this...' }
			await sleep(50)
			pi++
			if (pi >= paragraphs.length) break
			// Text: 2-5 paragraphs
			const ac = Math.min(2 + Math.floor(Math.random() * 4), paragraphs.length - pi)
			const text = paragraphs.slice(pi, pi + ac).join('\n\n')
			yield* streamChunks(text.match(/.{1,60}/gs) ?? [text], 30)
			pi += ac
		}
		yield { type: 'done', usage: { input: tokenCount, output: corpus.length } }
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
