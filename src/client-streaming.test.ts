import { beforeEach, describe, expect, test } from 'bun:test'
import { client } from './client.ts'
import { blocks as blockModule } from './cli/blocks.ts'
function makeTab(sessionId = 's1') {
	return {
		sessionId,
		name: `tab ${sessionId}`,
		history: [],
		inputHistory: [],
		inputDraft: '',
		loaded: true,
		doneUnseen: false, parentEntryCount: 0,
		historyVersion: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: '/tmp',
		model: 'openai/gpt-5.4',
	}
}

describe('client streaming blocks', () => {
	beforeEach(() => {
		client.resetForTests()
		client.state.tabs.length = 0
		client.state.tabs.push(makeTab())
		client.state.activeTab = 0
	})


	test('paused info waits briefly before rendering', async () => {
		client.handleEvent({
			type: 'info',
			sessionId: 's1',
			text: '[paused]',
			createdAt: '2026-04-05T17:31:00.000Z',
		})
		expect(client.currentTab()!.history).toHaveLength(0)
		await Bun.sleep(client.config.pausedNoticeDelayMs + 10)
		expect(client.currentTab()!.history).toHaveLength(1)
		expect(client.currentTab()!.history[0]).toMatchObject({ type: 'info', text: '[paused]' })
	})

	test('steering prompt cancels a pending paused info block', async () => {
		client.handleEvent({
			type: 'info',
			sessionId: 's1',
			text: '[paused]',
			createdAt: '2026-04-05T17:31:00.000Z',
		})
		client.handleEvent({
			type: 'prompt',
			sessionId: 's1',
			text: 'Steer',
			label: 'steering',
			createdAt: '2026-04-05T17:31:00.010Z',
		})
		await Bun.sleep(client.config.pausedNoticeDelayMs + 10)
		expect(client.currentTab()!.history).toHaveLength(1)
		expect(client.currentTab()!.history[0]).toMatchObject({ type: 'user', text: 'Steer', status: 'steering' })
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

	test('background stream updates do not repaint the active tab', () => {
		client.state.tabs.push(makeTab('s2'))
		let repaints = 0
		client.setOnChange(() => { repaints++ })
		client.handleEvent({
			type: 'stream-delta',
			sessionId: 's2',
			channel: 'assistant',
			text: 'hello',
			createdAt: '2026-04-05T17:31:00.000Z',
		})
		expect(repaints).toBe(0)
		expect(client.state.tabs[1]!.history).toHaveLength(1)
		client.handleEvent({ type: 'stream-end', sessionId: 's2' })
		expect(repaints).toBe(0)
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


	test('info during assistant streaming starts a continuation chunk and response does not duplicate it', () => {
		client.handleEvent({
			type: 'stream-delta',
			sessionId: 's1',
			channel: 'assistant',
			text: 'hello ',
			createdAt: '2026-04-05T17:31:00.000Z',
		})
		client.handleEvent({
			type: 'info',
			sessionId: 's1',
			text: 'system.md was reloaded',
			createdAt: '2026-04-05T17:31:01.000Z',
		})
		client.handleEvent({
			type: 'stream-delta',
			sessionId: 's1',
			channel: 'assistant',
			text: 'world',
			createdAt: '2026-04-05T17:31:02.000Z',
		})
		client.handleEvent({
			type: 'response',
			sessionId: 's1',
			text: 'hello world',
			createdAt: '2026-04-05T17:31:03.000Z',
		})

		const tab = client.currentTab()!
		expect(tab.history).toHaveLength(3)
		expect(tab.history[0]).toMatchObject({ type: 'assistant', text: 'hello ' })
		expect(tab.history[1]).toMatchObject({ type: 'info', text: 'system.md was reloaded' })
		expect(tab.history[2]).toMatchObject({ type: 'assistant', text: 'world' })
		expect((tab.history[0] as any).id).toEqual(expect.any(String))
		expect((tab.history[2] as any).continue).toBe((tab.history[0] as any).id)
	})


test('tool-result reloads full blob output for edit blocks', async () => {
	client.state.tabs.length = 0
	client.state.tabs.push(makeTab())
	client.state.activeTab = 0
	const originalLoadBlobs = blockModule.loadBlobs
	blockModule.loadBlobs = async (items) => {
		const tool = items[0] as any
		tool.output = `--- before\n2:old old line\n\n+++ after\n2:new new line`
		tool.blobLoaded = true
		return 1
	}
	try {
		client.handleEvent({
			type: 'tool-call',
			sessionId: 's1',
			toolId: 'tool-1',
			name: 'edit',
			input: { path: 'notes.txt' },
			blobId: '000002-def',
			createdAt: '2026-04-05T17:31:01.000Z',
		})
		client.handleEvent({
			type: 'tool-result',
			sessionId: 's1',
			toolId: 'tool-1',
			blobId: '000002-def',
			output: 'preview only',
			createdAt: '2026-04-05T17:31:02.000Z',
		})
		await Bun.sleep(0)

		const tab = client.currentTab()!
		expect(tab.history).toHaveLength(1)
		expect(tab.history[0]).toMatchObject({
			type: 'tool',
			name: 'edit',
			blobId: '000002-def',
			output: `--- before\n2:old old line\n\n+++ after\n2:new new line`,
		})
	} finally {
		blockModule.loadBlobs = originalLoadBlobs
	}
})


test('response errors keep blob metadata for later inspection', () => {
	client.resetForTests()
	client.state.tabs.length = 0
	client.state.tabs.push(makeTab())
	client.state.activeTab = 0

	client.handleEvent({
		type: 'response',
		sessionId: 's1',
		isError: true,
		text: '503:\nOur servers are currently overloaded. Please try again later.',
		blobId: '000003-err',
		createdAt: '2026-04-05T17:31:02.000Z',
	})

	const tab = client.currentTab()!
	expect(tab.history).toHaveLength(1)
	expect(tab.history[0]).toMatchObject({
		type: 'error',
		text: '503:\nOur servers are currently overloaded. Please try again later.',
		blobId: '000003-err',
		sessionId: 's1',
	})
})

})
