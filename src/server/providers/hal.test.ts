import { afterEach, expect, test } from 'bun:test'
import type { Message } from '../../common/protocol.ts'
import { halProvider } from './hal.ts'

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
