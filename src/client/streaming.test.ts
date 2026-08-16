import { beforeEach, describe, expect, test } from 'bun:test'
import { client } from './app.ts'
import { blockData } from './block-data.ts'
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
		client.state.focusedTabIndex = 0
	})

	test('tool confirmation requests call the TUI hook', () => {
		let seen: any = null
		client.setOnToolConfirmRequest((event) => { seen = event })
		client.handleEvent({ type: 'tool-confirm-request', sessionId: 's1', requestId: 'r1', body: ['risky'] })
		expect(seen?.requestId).toBe('r1')
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
		expect(client.currentTab()!.history[0]).toMatchObject({ type: 'log', text: '[paused]' })
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

	test('command error info events are not retryable', () => {
		client.handleEvent({
			type: 'info',
			sessionId: 's1',
			level: 'error',
			text: 'Name may contain letters, digits, spaces, dot, dash, and underscore only.',
			retryable: false,
			createdAt: '2026-04-05T17:31:00.000Z',
		})

		expect(client.currentTab()!.history.at(-1)).toMatchObject({ type: 'error', retryable: false })
		expect(client.continueActionForCurrentTurn()).toBe(false)
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

	test('background stream updates do not repaint the focused tab', () => {
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



	test('info during assistant streaming preserves both chunks in event order', () => {
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

		const tab = client.currentTab()!
		expect(tab.history).toMatchObject([
			{ type: 'assistant', text: 'hello ' },
			{ type: 'log', text: 'system.md was reloaded' },
			{ type: 'assistant', text: 'world' },
		])
	})


	test('running tool output updates directly without reloading its blob', async () => {
		const originalLoadBlobs = blockData.loadBlobs
		let loads = 0
		blockData.loadBlobs = async () => {
			loads++
			return 0
		}
		try {
			client.handleEvent({
				type: 'tool-call',
				sessionId: 's1',
				toolId: 'tool-1',
				name: 'bash',
				input: { command: 'slow-command' },
				blobId: '000002-def',
			})
			client.handleEvent({
				type: 'tool-result',
				sessionId: 's1',
				toolId: 'tool-1',
				blobId: '000002-def',
				output: 'first line',
				phase: 'running',
			})
			await Bun.sleep(0)

			expect(loads).toBe(0)
			expect(client.currentTab()!.history[0]).toMatchObject({ type: 'tool', output: 'first line', running: true })
			client.handleEvent({ type: 'tool-result', sessionId: 's1', toolId: 'tool-1', blobId: '000002-def', output: 'final line', phase: 'done' })
			await Bun.sleep(0)
			expect((client.currentTab()!.history[0] as any).running).toBeUndefined()
		} finally {
			blockData.loadBlobs = originalLoadBlobs
		}
	})

test('tool-result reloads full blob output for edit blocks', async () => {
	client.state.tabs.length = 0
	client.state.tabs.push(makeTab())
	client.state.focusedTabIndex = 0
	const originalLoadBlobs = blockData.loadBlobs
	blockData.loadBlobs = async (items) => {
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
		blockData.loadBlobs = originalLoadBlobs
	}
})


test('response errors keep blob metadata for later inspection', () => {
	client.resetForTests()
	client.state.tabs.length = 0
	client.state.tabs.push(makeTab())
	client.state.focusedTabIndex = 0

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
