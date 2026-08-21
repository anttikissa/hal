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

async function collect(messages: Message[]): Promise<any[]> {
	const events: any[] = []
	for await (const event of halProvider.provider.generate({
		messages,
		model: 'intro',
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
