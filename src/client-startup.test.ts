import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { client } from './client.ts'
import { ipc, type SharedState } from './ipc.ts'
import { sessions } from './server/sessions.ts'
import { draft } from './cli/draft.ts'
import { liveFiles } from './utils/live-file.ts'

function makeLoadedSession(id: string) {
	return {
		meta: {
			id,
			workingDir: `/tmp/${id}`,
			createdAt: '2026-04-09T20:00:00.000Z',
			model: 'openai/gpt-5.4',
		},
		history: [],
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
	const origLoadAllSessions = sessions.loadAllSessions
	const origLoadDraft = draft.loadDraft
	const origReadState = ipc.readState
	const origTailEvents = ipc.tailEvents
	const origLiveFile = liveFiles.liveFile
	const origOnChange = liveFiles.onChange
	const origLoadLive = sessions.loadLive

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
		client.setOnChange(() => {})
		client.setOnTabSwitch(() => {})
		client.setOnDraftArrived(() => {})
	})

	afterEach(() => {
		sessions.loadAllSessions = origLoadAllSessions
		draft.loadDraft = origLoadDraft
		ipc.readState = origReadState
		ipc.tailEvents = origTailEvents
		liveFiles.liveFile = origLiveFile
		liveFiles.onChange = origOnChange
		sessions.loadLive = origLoadLive
	})

	test('bootstraps tabs from shared state instead of replaying old events', async () => {
		sessions.loadAllSessions = () => [makeLoadedSession('s1'), makeLoadedSession('s2')]
		draft.loadDraft = () => ''

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

	test('does not clear disk-loaded tabs when shared state is temporarily empty', async () => {
		sessions.loadAllSessions = () => [makeLoadedSession('s1')]
		draft.loadDraft = () => ''

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

	test('tails events from the end without replaying the whole event log', async () => {
		sessions.loadAllSessions = () => [makeLoadedSession('s1')]
		draft.loadDraft = () => ''

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
		sessions.loadAllSessions = () => [makeLoadedSession('s1')]
		sessions.loadLive = () => ({
			busy: true,
			activity: 'generating...',
			blocks: [{ type: 'assistant', text: 'hello', streaming: true, ts: Date.parse('2026-04-09T20:01:00.000Z') }],
			updatedAt: '2026-04-09T20:01:00.000Z',
		})
		draft.loadDraft = () => ''

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

		expect(client.currentTab()?.history).toMatchObject([
			{ type: 'assistant', text: 'hello', streaming: true, ts: Date.parse('2026-04-09T20:01:00.000Z') },
		])
	})
})
