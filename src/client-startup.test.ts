import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { client } from './client.ts'
import { ipc, type SharedState } from './ipc.ts'
import { sessions } from './server/sessions.ts'
import { draft } from './cli/draft.ts'
import { liveFiles } from './utils/live-file.ts'
import { blocks as blockModule } from './cli/blocks.ts'

function makeSessionMeta(id: string) {
	return {
		id,
		workingDir: `/tmp/${id}`,
		createdAt: '2026-04-09T20:00:00.000Z',
		model: 'openai/gpt-5.4',
	}
}

function makeSharedState(ids: string[]): SharedState {
	return {
		sessions: ids,
		openSessions: ids.map((id, i) => ({
			id,
			name: `tab ${i + 1}`,
			cwd: `/tmp/${id}`,
			model: 'openai/gpt-5.4',
		})),
		busy: {},
		activity: {},
		updatedAt: '2026-04-09T20:00:00.000Z',
	}
}

describe('client startup', () => {
	const origLoadAllSessionMetas = sessions.loadAllSessionMetas
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origLoadAllHistoryWithOrigin = sessions.loadAllHistoryWithOrigin
	const origLoadDraft = draft.loadDraft
	const origReadState = ipc.readState
	const origAppendCommand = ipc.appendCommand
	const origTailEvents = ipc.tailEvents
	const origLiveFile = liveFiles.liveFile
	const origOnChange = liveFiles.onChange
	const origLoadLive = sessions.loadLive
	const origLoadBlobs = blockModule.loadBlobs
	beforeEach(() => {
		client.state.tabs.length = 0
		client.state.activeTab = 0
		client.state.promptText = ''
		client.state.promptCursor = 0
		client.state.role = 'client'
		client.state.pid = process.pid
		client.state.hostPid = null
		client.state.peak = 0
		client.state.peakCols = 0
		client.state.model = null
		client.state.busy.clear()
		client.state.activity.clear()
		client.resetForTests()
		client.setOnChange(() => {})
		client.setOnTabSwitch(() => {})
		client.setOnDraftArrived(() => {})
		sessions.loadAllSessionMetas = () => []
		sessions.loadSessionMeta = (id) => makeSessionMeta(id)
		sessions.loadAllHistoryWithOrigin = () => ({ entries: [], parentCount: 0 })
		sessions.loadLive = () => ({ busy: false, activity: '', blocks: [], updatedAt: '' })
		draft.loadDraft = () => ''
		// Client tests must never append to the real shared IPC command log.
		// Individual tests can override this stub to assert what would be sent.
		ipc.appendCommand = () => {}
	})

	afterEach(() => {
		sessions.loadAllSessionMetas = origLoadAllSessionMetas
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.loadAllHistoryWithOrigin = origLoadAllHistoryWithOrigin
		draft.loadDraft = origLoadDraft
		ipc.readState = origReadState
		ipc.appendCommand = origAppendCommand
		ipc.tailEvents = origTailEvents
		liveFiles.liveFile = origLiveFile
		liveFiles.onChange = origOnChange
		sessions.loadLive = origLoadLive
		blockModule.loadBlobs = origLoadBlobs
	})

	test('bootstraps tabs from shared state instead of replaying old events', async () => {
		sessions.loadAllSessionMetas = () => [makeSessionMeta('s1'), makeSessionMeta('s2')]

		const shared = makeSharedState(['s1'])
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		expect(client.state.tabs.map((tab) => tab.sessionId)).toEqual(['s1'])
	})

	test('falls back to disk session metadata when shared state is temporarily empty', async () => {
		sessions.loadAllSessionMetas = () => [makeSessionMeta('s1')]

		const shared = makeSharedState([])
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		expect(client.state.tabs.map((tab) => tab.sessionId)).toEqual(['s1'])
	})

	test('startup fallback uses fork-aware history loading', async () => {
		sessions.loadAllSessionMetas = () => [{ ...makeSessionMeta('child'), forkedFrom: 'parent' }]
		sessions.loadSessionMeta = () => ({ ...makeSessionMeta('child'), forkedFrom: 'parent' })
		sessions.loadAllHistoryWithOrigin = () => ({
			entries: [
				{ type: 'user', parts: [{ type: 'text', text: 'before fork' }], ts: '2026-04-09T20:00:00.000Z' },
				{ type: 'user', parts: [{ type: 'text', text: 'after fork' }], ts: '2026-04-09T20:01:00.000Z' },
			],
			parentCount: 1,
			parentId: 'parent',
		})

		const shared = makeSharedState([])
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.forkedFrom).toBe('parent')
		// Filter out the startup block that gets appended automatically
		const nonStartup = client.currentTab()?.history.filter(b => b.type !== 'startup')
		expect(nonStartup).toMatchObject([
			{ type: 'user', text: 'before fork', dimmed: true },
			{ type: 'user', text: 'after fork' },
		])
	})

	test('loads blobs for tabs opened after startup', async () => {
		sessions.loadAllSessionMetas = () => [makeSessionMeta('s1'), makeSessionMeta('s2')]
		sessions.loadAllHistoryWithOrigin = (id) => id === 's2'
			? {
				entries: [{ type: 'tool_call', toolId: 'tool-1', name: 'read', blobId: 'blob-1', ts: '2026-04-09T20:01:00.000Z' }],
				parentCount: 0,
			}
			: { entries: [], parentCount: 0 }

		const shared = makeSharedState(['s1'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: (() => void) | undefined
		ipc.readState = () => shared
		liveFiles.liveFile = (path) => path.endsWith('/ipc/state.ason') ? shared as any : hostLock as any
		liveFiles.onChange = (file, cb) => {
			if (file === shared) onIpcChange = cb
		}
		ipc.tailEvents = async function* () {}

		const blobLoads: string[][] = []
		blockModule.loadBlobs = async (blocks) => {
			blobLoads.push(blocks.map((b) => ('sessionId' in b && b.sessionId) ? b.sessionId : ''))
			return 0
		}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		blobLoads.length = 0

		shared.sessions = ['s1', 's2']
		shared.openSessions = ['s1', 's2'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		expect(onIpcChange).toBeTruthy()
		onIpcChange?.()
		await Bun.sleep(10)
		ac.abort()

		expect(blobLoads).toContainEqual(['s2'])
	})

	test('closing the active tab returns to the most recently visited surviving tab', async () => {
		const shared = makeSharedState(['s1', 's2', 's3'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: (() => void) | undefined
		ipc.readState = () => shared
		liveFiles.liveFile = (path) => path.endsWith('/ipc/state.ason') ? shared as any : hostLock as any
		liveFiles.onChange = (file, cb) => {
			if (file === shared) onIpcChange = cb
		}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		client.switchTab(1)
		client.switchTab(2)

		shared.sessions = ['s1', 's2']
		shared.openSessions = ['s1', 's2'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.()
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s2')
	})

	test('opening a tab activates the new session, and closing it returns to the previous tab', async () => {
		const shared = makeSharedState(['s1', 's2'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: (() => void) | undefined
		const appendedCommands: any[] = []
		ipc.readState = () => shared
		ipc.appendCommand = (command) => {
			appendedCommands.push(command)
		}
		liveFiles.liveFile = (path) => path.endsWith('/ipc/state.ason') ? shared as any : hostLock as any
		liveFiles.onChange = (file, cb) => {
			if (file === shared) onIpcChange = cb
		}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		client.switchTab(1)
		client.sendCommand('open')
		expect(appendedCommands).toEqual([{ type: 'open', text: undefined, sessionId: 's2' }])

		shared.sessions = ['s1', 's2', 's3']
		shared.openSessions = ['s1', 's2', 's3'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.()
		await Bun.sleep(10)
		expect(client.currentTab()?.sessionId).toBe('s3')

		shared.sessions = ['s1', 's2']
		shared.openSessions = ['s1', 's2'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.()
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s2')
	})

	test('closing a forked middle tab returns to the parent tab, not the tab on the right', async () => {
		const shared = makeSharedState(['s1', 's3', 's2'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: (() => void) | undefined
		ipc.readState = () => shared
		liveFiles.liveFile = (path) => path.endsWith('/ipc/state.ason') ? shared as any : hostLock as any
		liveFiles.onChange = (file, cb) => {
			if (file === shared) onIpcChange = cb
		}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		client.switchTab(0)
		client.switchTab(1)

		shared.sessions = ['s1', 's2']
		shared.openSessions = [
			{ id: 's1', name: 'tab 1', cwd: '/tmp/s1', model: 'openai/gpt-5.4' },
			{ id: 's2', name: 'tab 2', cwd: '/tmp/s2', model: 'openai/gpt-5.4' },
		]
		onIpcChange?.()
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s1')
	})

	test('tails events from the end without replaying the whole event log', async () => {
		const shared = makeSharedState(['s1'])
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}

		let tailCalls = 0
		ipc.tailEvents = async function* () {
			tailCalls++
		}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		expect(tailCalls).toBe(1)
	})

	test('loads live session blocks on startup for tabs opened mid-turn', async () => {
		sessions.loadLive = () => ({
			busy: true,
			activity: 'generating...',
			blocks: [{ type: 'assistant', text: 'hello', streaming: true, ts: Date.parse('2026-04-09T20:01:00.000Z') }],
			updatedAt: '2026-04-09T20:01:00.000Z',
		})

		const shared = makeSharedState(['s1'])
		shared.busy.s1 = true
		shared.activity.s1 = 'generating...'
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		// Filter out the startup block that gets appended automatically
		const nonStartup = client.currentTab()?.history.filter(b => b.type !== 'startup')
		expect(nonStartup).toMatchObject([
			{ type: 'assistant', text: 'hello', streaming: true, ts: Date.parse('2026-04-09T20:01:00.000Z') },
		])
	})
})
