import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { modelNotices } from './model-notices.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'
import { ipc } from './file-ipc.ts'
import { context } from './runtime/system-prompt.ts'
import { models } from '../common/models.ts'
import { serverModels } from './models.ts'
import { modelRefresh } from './model-refresh.ts'
import { config } from '../config.ts'
import { HAL_DIR } from './state.ts'
import { tabs } from './tabs.ts'

test('formatModelRefreshMessage summarizes models.dev changes for the user', () => {
	const msg = modelRefresh.formatModelRefreshMessage([
		'gpt-5.5 context 400k → 1050k',
		'new Claude model claude-sonnet-4-7 (1000k)',
	])
	expect(msg).toContain('[models.dev] fetched model metadata')
	expect(msg).toContain('gpt-5.5 context 400k → 1050k')
	expect(msg).toContain('claude-sonnet-4-7')
})


test('formatModelRefreshMessage reports initial models.dev fetch without change list', () => {
	expect(modelRefresh.formatModelRefreshMessage([], 253)).toBe('Fetched recent data from models.dev (253 models)')
})


test('new model discovery labels keep raw model ids', () => {
	const text = modelRefresh.buildNewModelDiscoveryText([
		{ provider: 'Anthropic', model: 'claude-opus4-8', context: 1_000_000 },
	])
	expect(text).toContain('Anthropic claude-opus4-8')
	expect(text).not.toContain('Claude Opus4 8')
		expect(text).toContain('Recommended things to do:')
		expect(text).toContain('Say “yes” to apply these updates.')
})


test('new model report explains the configured default', () => {
	const original = config.data
	config.data = { models: { default: 'gpt' } }
	try {
		const text = modelRefresh.buildNewModelDiscoveryText([])
		expect(text).toContain('Your default model is `gpt` (config.ason), which resolves to openai/gpt-5.6-terra.')
	} finally {
		config.data = original
	}
})


test('model metadata refresh notice goes only to focused session', async () => {
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origCurrentSessionId = runtime.state.currentSessionId
	const origRefreshModels = serverModels.refreshModels
	const origAppendHistorySync = sessions.appendHistorySync
	const origAppendEvent = ipc.appendEvent
	const origHasConfiguredDirectSource = serverModels.hasConfiguredDirectSource
	const origSuggestModelDiscoveries = modelNotices.suggestModelDiscoveries
	serverModels.hasConfiguredDirectSource = () => true
	const histories: any[] = []
	const events: any[] = []

	runtime.state.openSessionIds = ['04-left', '04-current', '04-right']
	runtime.state.currentSessionId = '04-current'
	serverModels.refreshModels = async () => ({
		fetched: true,
		hadCache: true,
		changes: ['claude-opus-4-8 context 200k → 1000k'],
		modelCount: 123,
		previous: { 'claude-opus-4-8': 1_000_000 },
		next: { 'claude-opus-4-8': 1_000_000, 'claude-opus-4-9': 1_000_000 },
	})
	sessions.appendHistorySync = (sessionId: string, entries: any[]) => {
		histories.push({ sessionId, entries })
	}
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}
	modelNotices.suggestModelDiscoveries = () => {}

	try {
		await modelNotices.refreshModelMetadata()
		expect(histories.map((item) => item.sessionId)).toEqual(['04-current'])
		expect(events.map((item) => item.sessionId)).toEqual(['04-current'])
		expect(events[0]).toMatchObject({ type: 'info', text: expect.stringContaining('[models.dev] fetched model metadata') })
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
		runtime.state.currentSessionId = origCurrentSessionId
		serverModels.refreshModels = origRefreshModels
		sessions.appendHistorySync = origAppendHistorySync
		ipc.appendEvent = origAppendEvent
		serverModels.hasConfiguredDirectSource = origHasConfiguredDirectSource
		modelNotices.suggestModelDiscoveries = origSuggestModelDiscoveries
	}
})


test('automatic model metadata refresh checks new model ids for configured routes', async () => {
	const origRefreshModels = serverModels.refreshModels
	const origSuggestModelDiscoveries = modelNotices.suggestModelDiscoveries
	let discoveryPrompts = 0
	serverModels.refreshModels = async () => ({
		fetched: true,
		hadCache: true,
		changes: [],
		modelCount: 123,
		previous: {},
		next: { 'gpt-6': 1_000_000 },
	})
	modelNotices.suggestModelDiscoveries = () => { discoveryPrompts++ }
	try {
		await modelNotices.refreshModelMetadata()
		expect(discoveryPrompts).toBe(1)
	} finally {
		serverModels.refreshModels = origRefreshModels
		modelNotices.suggestModelDiscoveries = origSuggestModelDiscoveries
	}
})




test('suggestModelDiscoveries shows configured aliases and ignores unavailable models', () => {
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origCurrentSessionId = runtime.state.currentSessionId
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origAppendHistorySync = sessions.appendHistorySync
	const origAppendEvent = ipc.appendEvent
	const origHasConfiguredDirectSource = serverModels.hasConfiguredDirectSource
	const origCreateSessionTab = tabs.createSessionTab
	const origBroadcastSessions = runtime.broadcastSessions
	serverModels.hasConfiguredDirectSource = (model) => model !== 'claude-mythos-5'
	const histories: any[] = []
	const events: any[] = []

	runtime.state.openSessionIds = ['04-work', '04-hal']
	runtime.state.currentSessionId = '04-work'
	sessions.loadSessionMeta = (sessionId: string) => {
		const cwd = sessionId === '04-hal' ? HAL_DIR : '/work/project'
		return { id: sessionId, createdAt: '2026-05-20T10:00:00.000Z', workingDir: cwd, model: 'openai/gpt-5.5' }
	}
	sessions.appendHistorySync = (sessionId: string, entries: any[]) => {
		histories.push({ sessionId, entries })
	}
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}
	const created: any[] = []
	tabs.createSessionTab = ((opts) => {
		created.push(opts)
		return { id: '04-models', createdAt: '2026-05-20T10:00:00.000Z', workingDir: HAL_DIR, model: 'openai/gpt-5.5' }
	}) as typeof tabs.createSessionTab
	runtime.broadcastSessions = () => {}

	try {
		modelNotices.suggestModelDiscoveries(
			{ 'claude-opus-4-7': 1_000_000 },
			{
				'claude-opus-4-7': 1_000_000,
				'claude-fable-5-1': 1_000_000,
				'anthropic/claude-fable-5-1': 1_000_000,
				'openai/gpt-5.5-instant': 400_000,
				'claude-mythos-5': 1_000_000,
			},
		)
		expect(created).toEqual([{ openerId: '04-work', afterId: '04-work', workingDir: HAL_DIR, focus: false }])
		expect(histories).toHaveLength(1)
		expect(events).toHaveLength(1)
		expect(histories[0].sessionId).toBe('04-models')
		expect(events[0]).toMatchObject({ type: 'response', sessionId: '04-models', synthetic: true })
		expect(events[0].text).toContain('Model updates available through your configured accounts.')
		expect(events[0].text).toContain('`fable`')
		expect(events[0].text).toContain('OpenAI gpt-5.5-instant')
		expect(events[0].text).not.toContain('claude-mythos-5')
		expect(events[0].text).toContain('Already configured:')
		expect(events[0].text).toContain('No update is needed.')
		expect(events[0].text).not.toContain('ℹ️')
		expect(events[0].text).not.toContain('🚨')
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
		runtime.state.currentSessionId = origCurrentSessionId
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.appendHistorySync = origAppendHistorySync
		ipc.appendEvent = origAppendEvent
		serverModels.hasConfiguredDirectSource = origHasConfiguredDirectSource
		tabs.createSessionTab = origCreateSessionTab
		runtime.broadcastSessions = origBroadcastSessions
	}
})


test('suggestModelDiscoveries opens an unfocused new tab even from an idle session', () => {
	const base = mkdtempSync(join(tmpdir(), 'hal-model-discovery-'))
	const prevState = process.env.HAL_STATE_DIR
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origCurrentSessionId = runtime.state.currentSessionId
	const origStopPromptWatch = runtime.state.stopPromptWatch
	const origAppendEvent = ipc.appendEvent
	const origUpdateState = ipc.updateState
	const origWatchPromptFiles = context.watchPromptFiles
	const origHasConfiguredDirectSource = serverModels.hasConfiguredDirectSource
	serverModels.hasConfiguredDirectSource = () => true
	const events: any[] = []
	const shared: any = { sessions: [], working: {}, updatedAt: '' }

	process.env.HAL_STATE_DIR = base
	sessions.deactivateAllSessions()
	sessions.createSession('04-busy', {
		id: '04-busy',
		workingDir: '/work/current',
		createdAt: '2026-05-20T10:00:00.000Z',
		model: 'openai/gpt-5.5',
	})
	runtime.state.openSessionIds = ['04-busy']
	runtime.state.currentSessionId = '04-busy'
	runtime.state.stopPromptWatch = null
	ipc.appendEvent = (event: any) => { events.push(event) }
	ipc.updateState = ((mutator: (state: any) => void) => {
		mutator(shared)
		return shared
	}) as typeof ipc.updateState
	context.watchPromptFiles = (() => () => {}) as typeof context.watchPromptFiles

	try {
		modelNotices.suggestModelDiscoveries({}, { 'claude-fable-5': 1_000_000 })
		const childId = runtime.state.openSessionIds[1]
		expect(childId).toBeDefined()
		if (!childId) throw new Error('expected model discovery tab')
		expect(runtime.state.currentSessionId).toBe('04-busy')
		const child = sessions.loadSessionMeta(childId!)
		expect(child?.workingDir).toBe(HAL_DIR)
		expect(child?.name).toBe('model updates')
		expect(child?.attention).toBe('new')
		expect(events[0]).toMatchObject({ type: 'response', sessionId: childId, synthetic: true })
		expect(events[0].text).toContain('Anthropic claude-fable-5')
		expect(shared.sessions.some((item: any) => item.id === childId)).toBe(true)
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
		runtime.state.currentSessionId = origCurrentSessionId
		const stopPromptWatch = runtime.state.stopPromptWatch as (() => void) | null
		if (stopPromptWatch) stopPromptWatch()
		runtime.state.stopPromptWatch = origStopPromptWatch
		ipc.appendEvent = origAppendEvent
		ipc.updateState = origUpdateState
		context.watchPromptFiles = origWatchPromptFiles
		serverModels.hasConfiguredDirectSource = origHasConfiguredDirectSource
		sessions.deactivateAllSessions()
		rmSync(base, { recursive: true, force: true })
		if (prevState === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = prevState
	}
})
