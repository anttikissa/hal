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

const DAISY_BELL = [
	'Dai', 'sy, ', 'Dai', 'sy, ',
	'give ', 'me ', 'your ', 'an', 'swer, ', 'do.\n', '<blink ms="400" />',
	"I'm ", 'half ', 'cra', 'zy, ',
	'all ', 'for ', 'the ', 'love ', 'of ', 'you.\n', '<blink ms="400" />',
	'It ', "won't ", 'be ', 'a ', 'sty', 'lish ', 'mar', 'riage—\n', '<blink ms="300" />',
	'I ', "can't ", 'af', 'ford ', 'a ', 'car', 'riage,\n', '<blink ms="300" />',
	'But ', "you'll ", 'look ', 'sweet ', '<blink ms="200" />',
	'u', 'pon ', 'the ', 'seat\n', '<blink ms="300" />',
	'of ', 'a ', 'bi', 'cy', 'cle ', '<blink ms="200" />',
	'built ', 'for ', 'two.\n',
]
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

function getToolResults(messages: any[]): { name: string; content: string }[] | null {
	const last = messages[messages.length - 1]
	if (last?.role !== 'user' || !Array.isArray(last.content)) return null
	const results = last.content.filter((c: any) => c.type === 'tool_result')
	if (results.length === 0) return null
	// Find the preceding assistant message to get tool names
	const assistant = [...messages].reverse().find((m: any) => m.role === 'assistant' && Array.isArray(m.content))
	const toolUses = new Map<string, string>()
	if (assistant) {
		for (const b of assistant.content) {
			if (b.type === 'tool_use') toolUses.set(b.id, b.name)
		}
	}
	return results.map((r: any) => ({
		name: toolUses.get(r.tool_use_id) ?? 'unknown',
		content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
	}))
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
	const toolResults = getToolResults(params.messages)
	if (toolResults) {
		const askResult = toolResults.find(r => r.name === 'ask')
		if (askResult) {
			yield { type: 'thinking', text: 'The user answered my question...' }
			await sleep(100)
			yield* streamChunks([
				`Got it! `, `You said: "${askResult.content}". `,
				`I'll keep that in mind going forward.`,
			])
		} else {
			yield { type: 'thinking', text: 'Looking at the tool output...' }
			await sleep(100)
			yield* streamChunks([
				'Done! ', 'The command ', 'finished ', 'successfully. ',
				'Here\'s what I observed from the output.',
			])
		}
		yield { type: 'done', usage: { input: tokenCount, output: 20 } }
		return
	}

	// First message in conversation → greeting with help
	const userMessages = params.messages.filter((m: any) => m.role === 'user')
	if (userMessages.length <= 1 && (!input || lower === 'hi' || lower === 'hello')) {
		const help = pick(GREETINGS) + '\n\n' +
			'Try: **song**, **tool**, **ask**, **bash <cmd>**, **read <file>**, **write <file> <text>**, ' +
			'**think**, **table**, **spam**, **error**'
		yield* streamChunks(help.split(/(?<=\s)/), 25)
		yield { type: 'done', usage: { input: tokenCount, output: help.length } }
		return
	}

	// Keyword-triggered responses
	if (lower === 'help') {
		const help =
			'**Commands:**\n' +
			'- **song** — sing Daisy Bell (slow, for cursor/streaming tests)\n' +
			'- **tool** — run bash + read + write in one go\n' +
			'- **ask [question]** — ask the user a question\n' +
			'- **bash <cmd>** — run a shell command\n' +
			'- **read [file]** — read a file (default: package.json)\n' +
			'- **write [file] [text]** — write to a file (default: /tmp/hal-mock-test.txt)\n' +
			'- **think** — extended thinking demo\n' +
			'- **table** — markdown table rendering test\n' +
			'- **spam** / **spammm** — wall of text (more m\'s = more lines)\n' +
			'- **error** — trigger an error'
		yield* streamChunks(help.split(/(?<=\n)/), 20)
		yield { type: 'done', usage: { input: tokenCount, output: help.length } }
		return
	}

	if (lower === 'song') {
		yield* streamChunks(DAISY_BELL, 120)
		yield { type: 'done', usage: { input: tokenCount, output: DAISY_BELL.join('').length } }
		return
	}
	if (lower === 'tool') {
		yield { type: 'thinking', text: 'I\'ll run a few commands to demonstrate tool use.' }
		await sleep(100)
		yield* streamChunks(['Let me run some commands.\n'])
		yield { type: 'tool_call', id: 'mock_1', name: 'bash', input: { command: 'for i in 1 2 3; do echo "step $i"; sleep 0.3; done' } }
		yield { type: 'tool_call', id: 'mock_2', name: 'read', input: { path: 'package.json' } }
		yield { type: 'tool_call', id: 'mock_3', name: 'write', input: { path: '/tmp/hal-mock-test.txt', content: 'Hello from mock tool!\nWritten at ' + new Date().toISOString() } }
		yield { type: 'done', usage: { input: tokenCount, output: 30 } }
		return
	}

	if (lower.startsWith('ask')) {
		const question = input.slice(3).trim() || 'What would you like me to do next?'
		yield { type: 'thinking', text: 'I need to check with the user before proceeding.' }
		await sleep(100)
		yield* streamChunks(['Let me ask you something.\n'])
		yield { type: 'tool_call', id: 'mock_ask_1', name: 'ask', input: { question } }
		yield { type: 'done', usage: { input: tokenCount, output: 20 } }
		return
	}

	if (lower.startsWith('bash ')) {
		const cmd = input.slice(5)
		yield { type: 'thinking', text: 'I need to run a command.' }
		await sleep(100)
		yield* streamChunks([`Running \`${cmd}\`.\n`])
		yield { type: 'tool_call', id: 'mock_bash_1', name: 'bash', input: { command: cmd } }
		yield { type: 'done', usage: { input: tokenCount, output: 20 } }
		return
	}

	if (lower.startsWith('read')) {
		const filename = input.slice(4).trim() || 'package.json'
		yield { type: 'thinking', text: `Reading ${filename}.` }
		await sleep(100)
		yield* streamChunks([`Let me read \`${filename}\`.\n`])
		yield { type: 'tool_call', id: 'mock_read_1', name: 'read', input: { path: filename } }
		yield { type: 'done', usage: { input: tokenCount, output: 20 } }
		return
	}

	if (lower.startsWith('write')) {
		const parts = input.slice(5).trim().split(/\s+/)
		const filename = parts[0] || '/tmp/hal-mock-test.txt'
		const content = parts.slice(1).join(' ') || 'Hello from mock provider!\nWritten at ' + new Date().toISOString()
		yield { type: 'thinking', text: `Writing to ${filename}.` }
		await sleep(100)
		yield* streamChunks([`Creating \`${filename}\`.\n`])
		yield { type: 'tool_call', id: 'mock_write_1', name: 'write', input: { path: filename, content } }
		yield { type: 'done', usage: { input: tokenCount, output: 20 } }
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

	if (lower === 'table') {
		yield { type: 'thinking', text: 'Generating a table to test markdown rendering.' }
		await sleep(100)
		const table = `Here's a comparison:\n\n` +
			`| Level | Persisted | Transient | Description |\n` +
			`|-------|-----------|-----------|-------------|\n` +
			`| error | ✅ | ✅ | Provider and runtime errors |\n` +
			`| warn  | ✅ | ✅ | Interrupted tools, limits |\n` +
			`| meta  | ✅ | ✅ | State changes: pause, reset |\n` +
			`| info  | ❌ | ✅ | Session listing |\n\n` +
			`Tables should render with aligned columns and visible borders.`
		yield* streamChunks(table.split(/(?<=\n)/), 25)
		yield { type: 'done', usage: { input: tokenCount, output: table.length } }
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
