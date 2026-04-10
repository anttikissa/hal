import { beforeEach, describe, expect, test } from 'bun:test'
import { client } from './client.ts'

function makeTab() {
	return {
		sessionId: 's1',
		name: 'tab 1',
		history: [],
		inputHistory: [],
		inputDraft: '',
		loaded: true,
		doneUnseen: false, parentEntryCount: 0,
		historyVersion: 0,
		usage: { input: 0, output: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: '/tmp',
		model: 'openai/gpt-5.4',
	}
}

describe('client streaming blocks', () => {
	beforeEach(() => {
		client.state.tabs.length = 0
		client.state.tabs.push(makeTab())
		client.state.activeTab = 0
	})

	test('thinking stream becomes a real block with blob metadata and survives stream end', () => {
		const createdAt = '2026-04-05T17:31:00.000Z'
		client.handleEvent({
			type: 'stream-start',
			sessionId: 's1',
		})
		client.handleEvent({
			type: 'stream-delta',
			sessionId: 's1',
			channel: 'thinking',
			text: 'hmm',
			blobId: '000001-abc',
			createdAt,
		})

		const tab = client.currentTab()!
		expect(tab.history).toHaveLength(1)
		expect(tab.history[0]).toMatchObject({
			type: 'thinking',
			text: 'hmm',
			blobId: '000001-abc',
			sessionId: 's1',
			ts: Date.parse(createdAt),
		})

		client.handleEvent({ type: 'stream-end', sessionId: 's1' })
		expect(tab.history).toHaveLength(1)
		expect(tab.history[0]).toMatchObject({ type: 'thinking', text: 'hmm' })
	})

	test('streamed assistant text stays before live tool blocks and response does not duplicate it', () => {
		client.handleEvent({
			type: 'stream-delta',
			sessionId: 's1',
			channel: 'assistant',
			text: 'hello',
			createdAt: '2026-04-05T17:31:00.000Z',
		})
		client.handleEvent({
			type: 'tool-call',
			sessionId: 's1',
			toolId: 'tool-1',
			name: 'read',
			input: { path: 'notes.txt' },
			blobId: '000002-def',
			createdAt: '2026-04-05T17:31:01.000Z',
		})
		client.handleEvent({
			type: 'response',
			sessionId: 's1',
			text: 'hello',
			createdAt: '2026-04-05T17:31:02.000Z',
		})

		const tab = client.currentTab()!
		expect(tab.history.map((block) => block.type)).toEqual(['assistant', 'tool'])
		expect(tab.history[0]).toMatchObject({ type: 'assistant', text: 'hello' })
		expect(tab.history[1]).toMatchObject({
			type: 'tool',
			toolId: 'tool-1',
			blobId: '000002-def',
			sessionId: 's1',
			input: { path: 'notes.txt' },
		})
	})

	test('ignores session and status events because shared state owns them', () => {
		client.state.busy.set('s1', true)
		client.state.activity.set('s1', 'generating...')

		client.handleEvent({
			type: 'sessions',
			sessions: [{ id: 's2', name: 'tab 2', cwd: '/tmp/s2', model: 'openai/gpt-5.4' }],
		})
		client.handleEvent({
			type: 'status',
			sessionId: 's1',
			busy: false,
			activity: '',
		})

		expect(client.state.tabs.map((tab) => tab.sessionId)).toEqual(['s1'])
		expect(client.state.busy.get('s1')).toBe(true)
		expect(client.state.activity.get('s1')).toBe('generating...')
	})
})
