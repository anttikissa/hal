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

test('unrecognized markup remains ordinary intro text', () => {
	expect(halProvider.pages('Hello <something/> world.')).toEqual([
		{
			steps: [{ type: 'text', text: 'Hello <something/> world.' }],
			text: 'Hello <something/> world.',
			pause: false,
		},
	])
})

test('scroll model emits two concurrent tool calls whose upper result finishes last', async () => {
	const events = await collect([], 'scroll')
	expect(events).toEqual([
		{
			type: 'tool_call',
			id: 'hal-scroll-slow',
			name: 'bash',
			input: { command: 'sleep 1; for i in {1..20}; do echo "TOP-$i"; done' },
		},
		{
			type: 'tool_call',
			id: 'hal-scroll-fast',
			name: 'bash',
			input: { command: 'for i in {1..20}; do echo "BOTTOM-$i"; done' },
		},
		{ type: 'done' },
	])
})

test('scroll model finishes after its tool results instead of repeating them', async () => {
	const events = await collect([
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'hal-scroll-fast', content: 'BOTTOM-1' }] },
	], 'scroll')
	expect(events).toEqual([
		{ type: 'text', text: 'Done. Scroll up and look for duplicated TOP or BOTTOM lines.' },
		{ type: 'done' },
	])
})

test('explicit script still overrides built-in HAL models', async () => {
	halProvider.script = 'Pinned.'
	expect(await collect([], 'scroll')).toEqual([{ type: 'text', text: 'Pinned.' }, { type: 'done' }])
})
