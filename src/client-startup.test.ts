import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { client } from './client.ts'
import { ipc, type SharedState } from './ipc.ts'
import { sessions } from './server/sessions.ts'
import { draft } from './cli/draft.ts'
import { liveFiles } from './utils/live-file.ts'
import { blocks as blockModule } from './cli/blocks.ts'
import { STATE_DIR, ensureDir } from './state.ts'
import { ason } from './utils/ason.ts'
import { log } from './utils/log.ts'
import { openaiUsage } from './openai-usage.ts'

type TestLiveFileChange = { path: string; previous: Record<string, any>; next: Record<string, any> }

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
		sessions: ids.map((id, i) => ({
			id,
			tab: i + 1,
			name: `tab ${i + 1}`,
			cwd: `/tmp/${id}`,
			model: 'openai/gpt-5.4',
		})),
		busy: {},
		activity: {},
		updatedAt: '2026-04-09T20:00:00.000Z',
	}
}

function nonBookkeepingHistory() {
	return client.currentTab()?.history.filter((block) => {
		if (block.type === 'startup') return false
		if (block.type === 'info' && block.text.startsWith('This session was last active ')) return false
		return true
	})
}

const CLIENT_STATE_PATH = `${STATE_DIR}/client.ason`

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
	const origLogError = log.error
	const origOpenAiCurrent = openaiUsage.current
	const origClientConfig = { ...client.config }
	let savedClientState: string | null = null
	beforeEach(() => {
		client.state.tabs.length = 0
		client.state.activeTab = 0
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
		Object.assign(client.config, origClientConfig)
		sessions.loadAllSessionMetas = () => []
		sessions.loadSessionMeta = (id) => makeSessionMeta(id)
		sessions.loadAllHistoryWithOrigin = () => ({ entries: [], parentCount: 0 })
		sessions.loadLive = () => ({ busy: false, activity: '', blocks: [], updatedAt: '' })
		draft.loadDraft = () => ''
		// Client tests must never append to the real shared IPC command log.
		// Individual tests can override this stub to assert what would be sent.
		ipc.appendCommand = () => {}
		savedClientState = existsSync(CLIENT_STATE_PATH) ? readFileSync(CLIENT_STATE_PATH, 'utf-8') : null
		ensureDir(STATE_DIR)
		rmSync(CLIENT_STATE_PATH, { force: true })
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
		log.error = origLogError
		openaiUsage.current = origOpenAiCurrent
		Object.assign(client.config, origClientConfig)
		if (savedClientState != null) writeFileSync(CLIENT_STATE_PATH, savedClientState)
		else rmSync(CLIENT_STATE_PATH, { force: true })
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

	test('shows a human startup summary without perf details by default', async () => {
		const home = process.env.HOME || '/home/test'
		const resetAt = Math.floor(Date.now() / 1000) + 60 * 60
		const shared: SharedState = {
			sessions: [{ id: 's1', tab: 1, name: 'tab 1', cwd: `${home}/sync/lippu`, model: 'openai/gpt-5.5' }],
			busy: {},
			activity: {},
			updatedAt: '2026-04-09T20:00:00.000Z',
		}
		sessions.loadSessionMeta = () => ({ ...makeSessionMeta('s1'), workingDir: `${home}/sync/lippu`, model: 'openai/gpt-5.5' })
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}
		openaiUsage.current = () => ({
			key: 'openai:0',
			planType: 'pro',
			primary: { usedPercent: 1, windowMinutes: 300, resetAt },
			pendingTokens: 0,
		})
		client.config.backgroundLoadTabs = false
		client.state.startupSummaryShown = false

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		const startup = client.currentTab()?.history.find((block) => block.type === 'startup')
		expect(startup?.text).toContain('Tab opened in ~/sync/lippu.')
		expect(startup?.text).toContain('Using GPT 5.5 via OpenAI (ChatGPT Pro subscription).')
		expect(startup?.text).toContain('1% used on 5h quota, resetting at ')
		expect(startup?.text).toMatch(/\(in 1 hour\)|\(in 60 minutes\)/)
		expect(startup?.text).not.toContain('Server started')
		expect(startup?.text).not.toContain('replay')
	})

	test('startup summary includes perf details when configured', async () => {
		const shared = makeSharedState(['s1'])
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}
		client.config.backgroundLoadTabs = false
		client.config.showStartupPerf = true
		client.state.startupSummaryShown = false

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		const startup = client.currentTab()?.history.find((block) => block.type === 'startup')
		expect(startup?.text).toContain('Tab opened in /tmp/s1.')
		expect(startup?.text).toContain('Joined server')
		expect(startup?.text).toContain('replay')
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

	test('invalid client.ason logs an explicit error and falls back to defaults', async () => {
		const shared = makeSharedState(['s1'])
		const errors: Array<{ message: string; data?: Record<string, unknown> }> = []
		log.error = (message: string, data?: Record<string, unknown>) => {
			errors.push({ message, data })
		}
		writeFileSync(CLIENT_STATE_PATH, '{ definitely not valid ason')
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		expect(client.state.tabs.map((tab) => tab.sessionId)).toEqual(['s1'])
		expect(client.state.activeTab).toBe(0)
		expect(errors.some((entry) => entry.message === 'failed to load client state')).toBe(true)
	})

	test('saved last tab wins on restart when it is in the requested cwd', async () => {
		writeFileSync(CLIENT_STATE_PATH, ason.stringify({
			lastTab: 's2',
			peak: 0,
			peakCols: 0,
			model: null,
			doneUnseen: [],
		}) + '\n')
		const shared: SharedState = {
			sessions: [
				{ id: 's1', tab: 1, name: 'tab 1', cwd: '/work/project', model: 'openai/gpt-5.4' },
				{ id: 's2', tab: 2, name: 'tab 2', cwd: '/work/project', model: 'openai/gpt-5.4' },
			],
			busy: {},
			activity: {},
			updatedAt: '2026-04-09T20:00:00.000Z',
		}
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal, { preferredCwd: '/work/project', preferredSessionId: 's1' })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s2')
	})

	test('startup openCwd queues without blocking and focuses the host-created tab', async () => {
		const shared = makeSharedState(['s1'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: ((change: TestLiveFileChange) => void) | undefined
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
		client.startClient(ac.signal, { preferredCwd: '/work/project', openCwd: '/work/project' })
		await Bun.sleep(10)
		expect(client.currentTab()?.sessionId).toBe('s1')
		expect(appendedCommands).toEqual([{ type: 'open', cwd: '/work/project', sessionId: 's1' }])

		shared.sessions = [
			{ id: 's1', tab: 1, name: 'tab 1', cwd: '/tmp/s1', model: 'openai/gpt-5.4' },
			{ id: 's2', tab: 2, name: 'tab 2', cwd: '/work/project', model: 'openai/gpt-5.4' },
		]
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s2')
	})

	test('restart tab wins even when another tab matches the requested cwd', async () => {
		writeFileSync(CLIENT_STATE_PATH, ason.stringify({
			lastTab: 's34',
			restartTab: 's34',
			peak: 0,
			peakCols: 0,
			model: null,
			doneUnseen: [],
		}) + '\n')
		const shared: SharedState = {
			sessions: [
				{ id: 's34', tab: 34, name: 'tab 34', cwd: '/other/project', model: 'openai/gpt-5.4' },
				{ id: 's35', tab: 35, name: 'tab 35', cwd: '/work/project', model: 'openai/gpt-5.4' },
			],
			busy: {},
			activity: {},
			updatedAt: '2026-04-09T20:00:00.000Z',
		}
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal, { preferredCwd: '/work/project', preferredSessionId: 's35' })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s34')
	})

	test('startup summary stays out of tabs that already have visible history', async () => {
		sessions.loadAllSessionMetas = () => [makeSessionMeta('s1')]
		sessions.loadAllHistoryWithOrigin = () => ({
			entries: [{ type: 'assistant', text: 'Howdy!', synthetic: true, model: 'openai/gpt-5.4', ts: '2026-04-09T20:01:00.000Z' }],
			parentCount: 0,
		})

		const shared = makeSharedState(['s1'])
		const hostLock = { pid: null, createdAt: '' }
		ipc.readState = () => shared
		liveFiles.liveFile = (path) => path.endsWith('/ipc/state.ason') ? shared as any : hostLock as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.history.filter((block) => block.type === 'startup')).toEqual([])
		expect(nonBookkeepingHistory()).toMatchObject([{ type: 'assistant', synthetic: true, model: 'openai/gpt-5.4', text: 'Howdy!' }])
	})

	test('adds an ephemeral last-active notice for stale sessions', async () => {
		const originalNow = Date.now
		const now = new Date(2026, 3, 12, 0, 0).getTime()
		const lastActive = new Date(2026, 3, 10, 20, 0)
		Date.now = () => now
		try {
			sessions.loadAllSessionMetas = () => [makeSessionMeta('s1')]
			sessions.loadAllHistoryWithOrigin = () => ({
				entries: [
					{ type: 'assistant', text: 'old work', synthetic: true, model: 'openai/gpt-5.4', ts: lastActive.toISOString() },
					{ type: 'info', text: '[models.dev] fetched model metadata', ts: new Date(2026, 3, 11, 23, 0).toISOString() },
				],
				parentCount: 0,
			})
			const shared = makeSharedState(['s1'])
			const hostLock = { pid: null, createdAt: '' }
			ipc.readState = () => shared
			liveFiles.liveFile = (path) => path.endsWith('/ipc/state.ason') ? shared as any : hostLock as any
			liveFiles.onChange = () => {}
			ipc.tailEvents = async function* () {}

			const ac = new AbortController()
			client.startClient(ac.signal)
			await Bun.sleep(10)
			ac.abort()

			const notice = client.currentTab()?.history.at(-1)
			expect(notice?.type).toBe('info')
			if (notice?.type !== 'info') throw new Error('missing stale-session notice')
			expect(notice.text).toBe('This session was last active 10 Apr 2026, 20:00 (1 day 4 hours ago)')
		} finally {
			Date.now = originalNow
		}
	})

	test('does not add a last-active notice for recently active sessions', async () => {
		const originalNow = Date.now
		Date.now = () => new Date(2026, 3, 12, 0, 0).getTime()
		try {
			sessions.loadAllSessionMetas = () => [makeSessionMeta('s1')]
			sessions.loadAllHistoryWithOrigin = () => ({
				entries: [{ type: 'assistant', text: 'recent work', synthetic: true, model: 'openai/gpt-5.4', ts: new Date(2026, 3, 11, 12, 30).toISOString() }],
				parentCount: 0,
			})
			const shared = makeSharedState(['s1'])
			const hostLock = { pid: null, createdAt: '' }
			ipc.readState = () => shared
			liveFiles.liveFile = (path) => path.endsWith('/ipc/state.ason') ? shared as any : hostLock as any
			liveFiles.onChange = () => {}
			ipc.tailEvents = async function* () {}

			const ac = new AbortController()
			client.startClient(ac.signal)
			await Bun.sleep(10)
			ac.abort()

			expect(client.currentTab()?.history.some((block) => block.type === 'info' && block.text.startsWith('This session was last active '))).toBe(false)
		} finally {
			Date.now = originalNow
		}
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
		expect(nonBookkeepingHistory()).toMatchObject([
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
		let onIpcChange: ((change: TestLiveFileChange) => void) | undefined
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

		shared.sessions = ['s1', 's2'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		expect(onIpcChange).toBeTruthy()
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		ac.abort()

		expect(blobLoads.some((items) => items.includes('s2'))).toBe(true)
	})

	test('closing the active last tab falls back to the left neighbor', async () => {
		const shared = makeSharedState(['s1', 's2', 's3'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: ((change: TestLiveFileChange) => void) | undefined
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

		shared.sessions = ['s1', 's2'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s2')
	})

	test('closing the last tab ignores remembered focus and falls back left', async () => {
		const shared = makeSharedState(['s1', 's2', 's3'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: ((change: TestLiveFileChange) => void) | undefined
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
		client.switchTab(0)
		client.switchTab(2)

		shared.sessions = ['s1', 's2'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s2')
	})

	test('opening a tab activates the new session, and closing it returns to the previous tab', async () => {
		const shared = makeSharedState(['s1', 's2'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: ((change: TestLiveFileChange) => void) | undefined
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
		expect(appendedCommands).toEqual([{ type: 'open', sessionId: 's2' }])

		shared.sessions = ['s1', 's2', 's3'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		expect(client.currentTab()?.sessionId).toBe('s3')

		shared.sessions = ['s1', 's2'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s2')
	})

	test('resuming a tab activates the reopened session', async () => {
		const shared = makeSharedState(['s1', 's2'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: ((change: TestLiveFileChange) => void) | undefined
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
		client.sendCommand('resume')
		expect(appendedCommands).toEqual([{ type: 'resume', sessionId: 's2' }])

		shared.sessions = ['s1', 's2', 's3'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s3')
		expect(client.currentTab()?.history.at(-1)).toMatchObject({ type: 'startup', text: 'Tab restored.' })
	})

	test('/self prompt activates the new session tab', async () => {
		const shared = makeSharedState(['s1', 's2'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: ((change: TestLiveFileChange) => void) | undefined
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
		client.sendCommand('prompt', '/self')

		shared.sessions = ['s1', 's2', 's3'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s3')
	})

	test('moving the active tab keeps that same session active after reordering', async () => {
		const shared = makeSharedState(['s1', 's2', 's3'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: ((change: TestLiveFileChange) => void) | undefined
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
		client.switchTab(2)
		client.sendCommand('move', '1')
		expect(appendedCommands).toEqual([{ type: 'move', position: 1, sessionId: 's3' }])

		shared.sessions = ['s3', 's1', 's2'].map((id, i) => ({ id, name: `tab ${i + 1}`, cwd: `/tmp/${id}`, model: 'openai/gpt-5.4' }))
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s3')
	})

	test('closing a middle tab switches to the right neighbor', async () => {
		const shared = makeSharedState(['s1', 's3', 's2'])
		const hostLock = { pid: null, createdAt: '' }
		let onIpcChange: ((change: TestLiveFileChange) => void) | undefined
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

		shared.sessions = [
			{ id: 's1', name: 'tab 1', cwd: '/tmp/s1', model: 'openai/gpt-5.4' },
			{ id: 's2', name: 'tab 2', cwd: '/tmp/s2', model: 'openai/gpt-5.4' },
		]
		onIpcChange?.({ path: '', previous: {}, next: shared })
		await Bun.sleep(10)
		ac.abort()

		expect(client.currentTab()?.sessionId).toBe('s2')
	})

	test('restores unseen-done checkmarks from client state on startup', async () => {
		ensureDir(STATE_DIR)
		writeFileSync(CLIENT_STATE_PATH, ason.stringify({
			lastTab: 's1',
			peak: 0,
			peakCols: 0,
			model: null,
			doneUnseen: ['s2'],
		}) + '\n')

		const shared = makeSharedState(['s1', 's2'])
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		expect(client.state.tabs.map((tab) => ({ id: tab.sessionId, doneUnseen: tab.doneUnseen }))).toEqual([
			{ id: 's1', doneUnseen: false },
			{ id: 's2', doneUnseen: true },
		])
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

	test('startup merge drops live blocks already persisted to history', async () => {
		sessions.loadAllHistoryWithOrigin = () => ({
			entries: [
				{ type: 'assistant', text: 'Focused tests are green. Running `./test` again for repo state.', ts: '2026-04-09T20:01:00.000Z' },
			],
			parentCount: 0,
		})
		sessions.loadLive = () => ({
			busy: false,
			activity: '',
			blocks: [{ type: 'assistant', text: 'Focused tests are green. Running `./test` again for repo state.', ts: Date.parse('2026-04-09T20:01:00.000Z') }],
			updatedAt: '2026-04-09T20:01:00.000Z',
		})

		const shared = makeSharedState(['s1'])
		ipc.readState = () => shared
		liveFiles.liveFile = () => shared as any
		liveFiles.onChange = () => {}
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		expect(nonBookkeepingHistory()).toMatchObject([
			{ type: 'assistant', text: 'Focused tests are green. Running `./test` again for repo state.' },
		])
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

		expect(nonBookkeepingHistory()).toMatchObject([
			{ type: 'assistant', text: 'hello', streaming: true, ts: Date.parse('2026-04-09T20:01:00.000Z') },
		])
	})
})
