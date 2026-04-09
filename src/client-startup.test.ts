import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { client } from './client.ts'
import { ipc } from './ipc.ts'
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

describe('client startup', () => {
	const origLoadAllSessions = sessions.loadAllSessions
	const origLoadDraft = draft.loadDraft
	const origReadAllEvents = ipc.readAllEvents
	const origTailEvents = ipc.tailEvents
	const origLiveFile = liveFiles.liveFile
	const origOnChange = liveFiles.onChange
	const origReadEventSnapshot = (ipc as any).readEventSnapshot
	const origTailEventsFrom = (ipc as any).tailEventsFrom

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
		ipc.readAllEvents = origReadAllEvents
		ipc.tailEvents = origTailEvents
		liveFiles.liveFile = origLiveFile
		liveFiles.onChange = origOnChange
		;(ipc as any).readEventSnapshot = origReadEventSnapshot
		;(ipc as any).tailEventsFrom = origTailEventsFrom
	})

	test('applies sessions updates that land after the snapshot but before tailing starts', async () => {
		sessions.loadAllSessions = () => [makeLoadedSession('s1'), makeLoadedSession('s2')]
		draft.loadDraft = () => ''
		liveFiles.liveFile = () => ({ pid: null, createdAt: '' } as any)
		liveFiles.onChange = () => {}

		const lateSessionsEvent = {
			type: 'sessions',
			sessions: [
				{ id: 's1', name: 'tab 1', cwd: '/tmp/s1', model: 'openai/gpt-5.4' },
			],
		}

		// Old startup logic reads a snapshot first, then starts tailing from the
		// current end. That misses events that arrive in between those two steps.
		// The fixed path uses a snapshot end offset and tails from that offset.
		;(ipc as any).readEventSnapshot = () => ({
			events: [{ type: 'runtime-start' }],
			endOffset: 123,
		})
		;(ipc as any).tailEventsFrom = async function* () {
			yield lateSessionsEvent
		}
		ipc.readAllEvents = () => [{ type: 'runtime-start' }]
		ipc.tailEvents = async function* () {}

		const ac = new AbortController()
		client.startClient(ac.signal)
		await Bun.sleep(10)
		ac.abort()

		expect(client.state.tabs.map((tab) => tab.sessionId)).toEqual(['s1'])
	})
})
