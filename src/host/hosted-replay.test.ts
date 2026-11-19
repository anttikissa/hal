// Hosted searches must remain evidence when history becomes the next request.
import { expect, test } from 'bun:test'
import { blocks, type HostedToolBlock } from '../common/blocks.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { anthropic } from './anthropic.ts'
import { openai } from './openai.ts'
import { provider } from './provider.ts'

const ts = '2026-01-01T00:00:00.000Z'

for (let [name, adapter] of Object.entries({ anthropic, openai })) {
	test(`${name} recorded search survives replay and either provider's next request`, async () => {
		let recording = Bun.file(`${import.meta.dir}/../fixtures/${name}-search.sse`)
		let events = []
		for await (let event of adapter.parse(provider.sse(recording.stream()))) events.push(event)
		let turn = blocks.collect(events, name)
		let search = turn.blocks.find((b): b is HostedToolBlock => b.type === 'hosted_tool')!
		expect(search).toBeDefined()
		let records: HistoryRecord[] = [
			{ type: 'user', blocks: [{ type: 'text', text: 'Find the hotel' }], ts },
			...turn.blocks.map((block): HistoryRecord => ({ type: 'assistant', block, ts })),
			{ type: 'assistant', block: { type: 'tool_call', id: 'c1', name: 'tool', input: { cmd: 'HELP' } }, ts },
			{ type: 'user', blocks: [{ type: 'tool_result', id: 'c1', output: 'Tools available' }], ts },
		]
		let messages = replay.toMessages(records)
		let req = { model: 'test', messages }
		for (let wire of [anthropic.toMessages(req), openai.input(req)]) {
			let text = JSON.stringify(wire)
			expect(text).toContain('Your web_search ran on the provider')
			expect(text).toContain(search.input.query as string)
			for (let line of search.output.split('\n').filter(Boolean)) expect(text).toContain(line)
			expect(text).not.toContain(search.id)
			expect(text).toContain('Tools available')
		}
		// As assistant text the model copied it and faked searches.
		let said = JSON.stringify(messages.filter((m) => m.role === 'assistant'))
		expect(said).not.toContain(search.input.query as string)
		expect(
			messages
				.filter((m) => m.role === 'assistant')
				.flatMap((m) => m.blocks)
				.filter((b) => b.type === 'tool_call'),
		).toHaveLength(1)
		expect(replay.toMessages(structuredClone(records))).toEqual(messages)
	})
}

test('a hosted failure keeps its input, status and full error without a missing-result error', () => {
	let records: HistoryRecord[] = [
		{ type: 'user', blocks: [{ type: 'text', text: 'Search' }], ts },
		{
			type: 'assistant',
			block: {
				type: 'hosted_tool',
				id: 's1',
				name: 'web_search',
				input: { query: 'hotel', limit: 2 },
				output: 'Web search failed: too_many_requests\ncomplete provider event',
				isError: true,
			},
			ts,
		},
	]
	let messages = replay.toMessages(records)
	let text = JSON.stringify(messages)
	expect(text).toContain('Your web_search failed on the provider')
	expect(text).toContain('hotel')
	expect(text).toContain('limit')
	expect(text).toContain('too_many_requests')
	expect(text).toContain('complete provider event')
	expect(messages.every((m) => m.blocks.every((b) => b.type === 'text'))).toBe(true)
})
