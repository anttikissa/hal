import { afterEach, expect, test } from 'bun:test'
import type { Message } from '../../common/protocol.ts'
import { halProvider } from './hal.ts'
import { serverModels } from '../models.ts'

const originalScript = halProvider.script
const originalWordsPerSecond = halProvider.config.wordsPerSecond
const originalSleep = halProvider.sleep

afterEach(() => {
	halProvider.script = originalScript
	halProvider.config.wordsPerSecond = originalWordsPerSecond
	halProvider.sleep = originalSleep
})

async function collect(messages: Message[], model = 'intro'): Promise<any[]> {
	const events: any[] = []
	for await (const event of halProvider.provider.generate({
		messages,
		model,
		systemPrompt: 'secret system prompt',
		tools: [],
	})) events.push(event)
	return events
}

test('HAL provider streams script words at its fixed rate without using request text', async () => {
	const delays: number[] = []
	halProvider.script = 'Hello HAL world.'
	halProvider.config.wordsPerSecond = 4
	halProvider.sleep = async (ms) => { delays.push(ms) }

	expect(await collect([{ role: 'user', content: 'private user text' }])).toEqual([
		{ type: 'text', text: 'Hello ' },
		{ type: 'text', text: 'HAL ' },
		{ type: 'text', text: 'world.' },
		{ type: 'done' },
	])
	expect(delays).toEqual([250, 250])
})

test('HAL provider interprets timed pauses, persistent config controls, and Enter pages', async () => {
	const delays: number[] = []
	halProvider.script = 'First.<pause for="0.5s"/><config key="renderStatus.tabsOpacity" value="1"/> Continue.<pause until="enter"/>Second.'
	halProvider.sleep = async (ms) => { delays.push(ms) }

	const first = await collect([])
	expect(first).toEqual([
		{ type: 'text', text: 'First.' },
		{ type: 'config', key: 'renderStatus.tabsOpacity', value: '1' },
		{ type: 'text', text: ' Continue.' },
		{ type: 'pause' },
	])
	expect(delays).toContain(500)

	const second = await collect([
		{ role: 'assistant', content: 'First. Continue.' },
		{ role: 'user', content: '<meta>The previous response was interrupted.</meta>' },
	])
	expect(second).toEqual([
		{ type: 'text', text: 'Second.' },
		{ type: 'done' },
	])
})

test('paged script advances when earlier pages merged into one assistant message', () => {
	// Consecutive intro pages have no user turn between them, so api-messages
	// concatenates them into a single assistant message.
	const pages = halProvider.pages('One.<pause until="enter"/>Two.<pause until="enter"/>Three.')
	const merged = [{ role: 'assistant' as const, content: 'One.Two.' }]

	expect(halProvider.nextPage(merged, pages)).toBe(2)
})

test('unrecognized markup remains ordinary intro text', () => {
	expect(halProvider.pages('Hello <something/> world.')).toEqual([
		{
			steps: [{ type: 'text', text: 'Hello <something/> world.' }],
			text: 'Hello <something/> world.',
			pause: false,
		},
	])
})

test('scroll model emits five concurrent frontier tools in call order', async () => {
	const events = await collect([], 'scroll')
	const calls = events.filter((event) => event.type === 'tool_call')

	expect(events[0]?.text).toContain('PHASE A')
	expect(calls.map((event) => event.id)).toEqual([
		'hal-scroll-a1',
		'hal-scroll-a2',
		'hal-scroll-a3',
		'hal-scroll-a4',
		'hal-scroll-a5',
	])
	expect(calls[0]?.input.command).toContain('echo A1-$i')
	expect(calls[4]?.input.command).toContain('{1..24}')
	expect(events.at(-1)).toEqual({ type: 'done' })
})


test('scroll model follows with a slow-leader batch after phase A results', async () => {
	const events = await collect([
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'hal-scroll-a1', content: 'A1-1' }] },
	], 'scroll')
	const calls = events.filter((event) => event.type === 'tool_call')

	expect(events[0]?.text).toContain('PHASE B')
	expect(calls.map((event) => event.id)).toEqual([
		'hal-scroll-b1',
		'hal-scroll-b2',
		'hal-scroll-b3',
		'hal-scroll-b4',
		'hal-scroll-b5',
	])
	expect(calls[0]?.input.command).toContain('echo B1-$i')
	expect(calls[1]?.input.command).toContain('sleep 1')
	expect(events.at(-1)).toEqual({ type: 'done' })
})


test('scroll model finishes after phase B tool results', async () => {
	const events = await collect([
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'hal-scroll-b1', content: 'B1-1' }] },
	], 'scroll')

	expect(events[0]?.text).toContain('SCROLL TEST COMPLETE')
	expect(events.at(-1)).toEqual({ type: 'done' })
})

test('explicit script still overrides built-in HAL models', async () => {
	halProvider.script = 'Pinned.'
	expect(await collect([], 'scroll')).toEqual([{ type: 'text', text: 'Pinned.' }, { type: 'done' }])
})

test('intro has one gate, then reveals the prompt before the instruments and finishes', async () => {
	halProvider.script = ''
	halProvider.sleep = async () => {}
	const first = await collect([])
	expect(first.at(-1)).toEqual({ type: 'pause' })
	const greeting = first.filter((event) => event.type === 'text').map((event) => event.text).join('')
	const rest = await collect([{ role: 'assistant', content: greeting }])
	expect(rest.at(-1)).toEqual({ type: 'done' })
	const reveals = rest.filter((event) => event.type === 'config' && event.key.startsWith('renderStatus.'))
	expect(reveals).toEqual([
		{ type: 'config', key: 'renderStatus.promptOpacity', value: '1' },
		{ type: 'config', key: 'renderStatus.helpOpacity', value: '1' },
		{ type: 'config', key: 'renderStatus.statusOpacity', value: '1' },
		{ type: 'config', key: 'renderStatus.tabsOpacity', value: '1' },
	])
	const text = rest.filter((event) => event.type === 'text').map((event) => event.text).join('')
	// These are functional command affordances, not assertions about generated prose.
	expect(text).toContain('/login claude')
	expect(text).toContain('/login chatgpt')
	expect(await collect([{ role: 'assistant', content: greeting + text }])).toEqual([{ type: 'done' }])
})

test('intro recognizes model API keys and suggests commands on the matching routes without exposing secrets', () => {
	const names = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GROK_API_KEY', 'SERPER_API_KEY']
	const saved = new Map(names.map((name) => [name, process.env[name]]))
	try {
		for (const name of names) delete process.env[name]
		for (const name of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) process.env[name] = `secret-${name}`
		const text = halProvider.providerSetupText()
		for (const name of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) expect(text).toContain(name)
		for (const command of ['/model gemini', '/model gpt', '/model deepseek']) expect(text).toContain(command)
		expect(text).not.toContain('secret-')
		expect(text).not.toContain('/model claude')

		for (const name of names) process.env[name] = `secret-${name}`
		const all = halProvider.providerSetupText()
		for (const name of names.filter((name) => name !== 'SERPER_API_KEY')) expect(all).toContain(name)
		expect(all).toContain('/model claude')
		// The grok alias uses OpenRouter; a direct xAI key needs the direct route.
		expect(all).toContain('/model grok/')
		expect(all.match(/\/model gemini/g)).toHaveLength(1)
		expect(all).not.toContain('SERPER_API_KEY')
		expect(all).not.toContain('secret-')

		for (const name of names) delete process.env[name]
		const none = halProvider.providerSetupText()
		expect(none).toContain('/login claude')
		expect(none).toContain('/login chatgpt')
		expect(none).not.toContain('/model gpt')
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
})

test('intro detects a custom API key only when Hal has an endpoint to use it with', () => {
	const key = process.env.INTRO_TEST_API_KEY
	const url = process.env.INTRO_TEST_BASE_URL
	try {
		process.env.INTRO_TEST_API_KEY = 'never-show-this-secret'
		delete process.env.INTRO_TEST_BASE_URL
		expect(halProvider.providerSetupText()).not.toContain('INTRO_TEST_API_KEY')
		process.env.INTRO_TEST_BASE_URL = 'https://example.invalid/v1'
		const text = halProvider.providerSetupText()
		expect(text).toContain('INTRO_TEST_API_KEY')
		expect(text).toContain('/model intro_test/<model-id>')
		expect(text).not.toContain('never-show-this-secret')
		expect(text).not.toContain('example.invalid')
	} finally {
		if (key === undefined) delete process.env.INTRO_TEST_API_KEY
		else process.env.INTRO_TEST_API_KEY = key
		if (url === undefined) delete process.env.INTRO_TEST_BASE_URL
		else process.env.INTRO_TEST_BASE_URL = url
	}
})

test('intro defaults to the best detected API-key route, breaks ties at random, and names the model', () => {
	const names = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'GROK_API_KEY']
	const saved = new Map(names.map((name) => [name, process.env[name]]))
	const originalRandom = halProvider.random
	try {
		for (const name of names) delete process.env[name]
		expect(halProvider.introDefaultModel()).toBe('gpt')
		process.env.GEMINI_API_KEY = 'secret'
		process.env.OPENROUTER_API_KEY = 'secret'
		expect(halProvider.introDefaultModel()).toBe('deepseek')
		process.env.OPENAI_API_KEY = 'secret'
		expect(halProvider.introDefaultModel()).toBe('gpt')
		process.env.ANTHROPIC_API_KEY = 'secret'
		halProvider.random = () => 0
		expect(halProvider.introDefaultModel()).toBe('claude')
		halProvider.random = () => 0.99
		expect(halProvider.introDefaultModel()).toBe('gpt')
		const last = halProvider.pages().at(-1)!
		expect(last.steps).toContainEqual({ type: 'config', key: 'models.default', value: 'gpt' })
		expect(last.text).toContain('default model to `gpt`, aliased to openai/gpt-5.6-terra (GPT 5.6 Terra)')
	} finally {
		halProvider.random = originalRandom
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
})

test('a skipped intro streams every remaining page at once without delays or gates', async () => {
	const delays: number[] = []
	halProvider.script = 'First page.<pause for="0.5s"/><config key="a" value="1"/><pause until="enter"/>Second.<pause until="enter"/><config key="b" value="2"/>Third.'
	halProvider.sleep = async (ms) => { delays.push(ms) }
	halProvider.state.skipped.add('s1')
	const events: any[] = []
	for await (const event of halProvider.provider.generate({ messages: [], model: 'intro', systemPrompt: '', tools: [], sessionId: 's1' })) events.push(event)
	expect(events).toEqual([
		{ type: 'text', text: 'First ' },
		{ type: 'text', text: 'page.' },
		{ type: 'config', key: 'a', value: '1' },
		{ type: 'text', text: 'Second.' },
		{ type: 'config', key: 'b', value: '2' },
		{ type: 'text', text: 'Third.' },
		{ type: 'done' },
	])
	expect(delays).toEqual([])
	expect(halProvider.state.skipped.has('s1')).toBe(false)
})

test('intro prefers the subscription when one key serves two providers', () => {
	// OPENCODE_API_KEY works for both OpenCode Zen (pay per token) and Go
	// (subscription). The subscription should be the one recommended, and the
	// variable named once.
	const key = process.env.OPENCODE_API_KEY
	try {
		process.env.OPENCODE_API_KEY = 'sk-opencode-test'
		serverModels.state.providers = {
			opencode: { api: 'https://opencode.ai/zen/v1', env: ['OPENCODE_API_KEY'] },
			'opencode-go': { api: 'https://opencode.ai/zen/go/v1', env: ['OPENCODE_API_KEY'] },
		}
		const text = halProvider.providerSetupText()
		expect(text.match(/OPENCODE_API_KEY/g)).toHaveLength(1)
		expect(text).toContain('/model opencode-go/kimi-k3')
		expect(text).not.toContain('/model opencode/<model-id>')
	} finally {
		if (key === undefined) delete process.env.OPENCODE_API_KEY
		else process.env.OPENCODE_API_KEY = key
		serverModels.state.providers = null
	}
})
