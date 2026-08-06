import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { modelNotices } from './model-notices.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'
import { ipc } from '../ipc.ts'
import { agentLoop } from '../runtime/agent-loop.ts'
import { context } from '../runtime/system-prompt.ts'
import { models } from '../models.ts'
import { modelRefresh } from '../model-refresh.ts'
import { HAL_DIR } from '../state.ts'
import { config } from '../config.ts'

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
})


test('model metadata refresh notice goes only to focused session', async () => {
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origCurrentSessionId = runtime.state.currentSessionId
	const origRefreshModels = models.refreshModels
	const origAppendHistorySync = sessions.appendHistorySync
	const origAppendEvent = ipc.appendEvent
	const histories: any[] = []
	const events: any[] = []

	runtime.state.openSessionIds = ['04-left', '04-current', '04-right']
	runtime.state.currentSessionId = '04-current'
	models.refreshModels = async () => ({
		fetched: true,
		hadCache: true,
		changes: ['new Claude model claude-opus-4-7 (1000k)'],
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

	try {
		await modelNotices.refreshModelMetadata()
		expect(histories.map((item) => item.sessionId)).toEqual(['04-current'])
		expect(events.map((item) => item.sessionId)).toEqual(['04-current'])
		expect(events[0]).toMatchObject({ type: 'info', text: expect.stringContaining('[models.dev] fetched model metadata') })
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
		runtime.state.currentSessionId = origCurrentSessionId
		models.refreshModels = origRefreshModels
		sessions.appendHistorySync = origAppendHistorySync
		ipc.appendEvent = origAppendEvent
	}
})


test('automatic model metadata refresh does not prompt for new model ids', async () => {
	const origRefreshModels = models.refreshModels
	const origSuggestAliasUpdates = modelNotices.suggestAliasUpdates
	const origSuggestModelDiscoveries = modelNotices.suggestModelDiscoveries
	let discoveryPrompts = 0
	models.refreshModels = async () => ({
		fetched: true,
		hadCache: true,
		changes: [],
		modelCount: 123,
		previous: {},
		next: { 'gpt-6': 1_000_000 },
	})
	modelNotices.suggestAliasUpdates = () => {}
	modelNotices.suggestModelDiscoveries = () => { discoveryPrompts++ }
	try {
		await modelNotices.refreshModelMetadata()
		expect(discoveryPrompts).toBe(0)
	} finally {
		models.refreshModels = origRefreshModels
		modelNotices.suggestAliasUpdates = origSuggestAliasUpdates
		modelNotices.suggestModelDiscoveries = origSuggestModelDiscoveries
	}
})


test('buildAliasUpdateSuggestionText mentions config mapping and subagent only outside ~/.hal', () => {
	const origConfigData = config.data
	config.data = { models: { default: 'gpt' } } as Record<string, any>
	const updates = [
		{ aliases: ['openai', 'gpt'], oldModel: 'openai/gpt-5.4', newModel: 'openai/gpt-5.5' },
		{ aliases: ['claude', 'opus'], oldModel: 'anthropic/claude-opus-4-6', newModel: 'anthropic/claude-opus-4-7' },
	]

	try {
		const outside = modelRefresh.buildAliasUpdateSuggestionText(updates, '/work/project')
		expect(outside).toContain('openai**, **gpt')
		expect(outside).toContain('openai/gpt-5.4')
		expect(outside).toContain('openai/gpt-5.5')
		expect(outside).toContain("config.ason sets the default model to **gpt**, which currently maps to **openai/gpt-5.6-terra**.")
		expect(outside).toContain('spawn a subagent in ~/.hal')

		const inside = modelRefresh.buildAliasUpdateSuggestionText(updates, HAL_DIR)
		expect(inside).toContain('update those aliases in ~/.hal')
		expect(inside).not.toContain('spawn a subagent')
	} finally {
		config.data = origConfigData
	}
})


test('suggestAliasUpdates emits one synthetic notice, preferring an open ~/.hal tab', () => {
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origAliasUpdateSuggestions = models.aliasUpdateSuggestions
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origAppendHistorySync = sessions.appendHistorySync
	const origAppendEvent = ipc.appendEvent
	const histories: any[] = []
	const events: any[] = []

	runtime.state.openSessionIds = ['04-work', '04-hal', '04-other']
	models.aliasUpdateSuggestions = () => [
		{ aliases: ['gemini'], oldModel: 'google/gemini-3-flash-preview', newModel: 'google/gemini-3.5-flash' },
	]
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

	try {
		modelNotices.suggestAliasUpdates({}, {})
		expect(histories).toHaveLength(1)
		expect(events).toHaveLength(1)
		expect(histories[0].sessionId).toBe('04-hal')
		expect(events[0]).toMatchObject({ type: 'response', sessionId: '04-hal', synthetic: true })
		expect(events[0].text).toContain('update those aliases in ~/.hal')
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
		models.aliasUpdateSuggestions = origAliasUpdateSuggestions
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.appendHistorySync = origAppendHistorySync
		ipc.appendEvent = origAppendEvent
	}
})


test('suggestModelDiscoveries emits a low-key informational notice for new Anthropic and OpenAI model ids', () => {
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origCurrentSessionId = runtime.state.currentSessionId
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origAppendHistorySync = sessions.appendHistorySync
	const origAppendEvent = ipc.appendEvent
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

	try {
		modelNotices.suggestModelDiscoveries(
			{ 'claude-opus-4-7': 1_000_000 },
			{
				'claude-opus-4-7': 1_000_000,
				'claude-fable-5': 1_000_000,
				'anthropic/claude-fable-5': 1_000_000,
				'openai/gpt-5.5-instant': 400_000,
			},
		)
		expect(histories).toHaveLength(1)
		expect(events).toHaveLength(1)
		expect(histories[0].sessionId).toBe('04-work')
		expect(events[0]).toMatchObject({ type: 'response', sessionId: '04-work', synthetic: true })
		expect(events[0].text).toContain('ℹ️ New model ids found in models.dev')
		expect(events[0].text).toContain('Anthropic claude-fable-5')
		expect(events[0].text).toContain('OpenAI gpt-5.5-instant')
		expect(events[0].text).toContain('This is informational')
		expect(events[0].text).not.toContain('Would you like')
		expect(events[0].text).not.toContain('🚨')
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
		runtime.state.currentSessionId = origCurrentSessionId
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.appendHistorySync = origAppendHistorySync
		ipc.appendEvent = origAppendEvent
	}
})


test('suggestModelDiscoveries opens a new Hal tab when focused session will resume after restart', () => {
	const base = mkdtempSync(join(tmpdir(), 'hal-model-discovery-'))
	const prevState = process.env.HAL_STATE_DIR
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origCurrentSessionId = runtime.state.currentSessionId
	const origStopPromptWatch = runtime.state.stopPromptWatch
	const origIsWorking = agentLoop.isWorking
	const origAppendEvent = ipc.appendEvent
	const origUpdateState = ipc.updateState
	const origWatchPromptFiles = context.watchPromptFiles
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
	agentLoop.isWorking = () => false
	sessions.appendHistorySync('04-busy', [
		{ type: 'user', parts: [{ type: 'text', text: 'keep going' }], ts: '2026-05-20T10:00:01.000Z' },
		{ type: 'log', text: '[restarted]', ts: '2026-05-20T10:00:02.000Z' },
	])
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
		expect(child?.name).toBe('new models')
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
		agentLoop.isWorking = origIsWorking
		ipc.appendEvent = origAppendEvent
		ipc.updateState = origUpdateState
		context.watchPromptFiles = origWatchPromptFiles
		sessions.deactivateAllSessions()
		rmSync(base, { recursive: true, force: true })
		if (prevState === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = prevState
	}
})
