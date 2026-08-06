import { expect, test } from 'bun:test'
import { runtime } from './runtime.ts'
import { queueRunner } from './queue-runner.ts'
import { tabs } from './tabs.ts'
import { sessions, type SessionMeta } from './sessions.ts'
import { ipc } from '../ipc.ts'
import { agentLoop } from '../runtime/agent-loop.ts'
import { context } from '../runtime/system-prompt.ts'
import { toolRegistry } from '../tools/tool.ts'
import { tokenCalibration } from '../token-calibration.ts'
import { models } from '../models.ts'
import { HAL_DIR } from '../state.ts'
import { config } from '../config.ts'
import { promptQueue } from '../runtime/prompt-queue.ts'
import { paths } from '../utils/paths.ts'
import { whatSummary } from '../session/what.ts'
import { apiMessages } from '../session/api-messages.ts'

test('runtime exposes in-memory focused sessions for eval helpers', () => {
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	try {
		runtime.state.openSessionIds = ['04-one', '04-two', '04-three']
		expect(runtime.state.openSessionIds[2]).toBe('04-three')
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
	}
})

test('client status commands update shared client process list', () => {
	const origUpdateState = ipc.updateState
	const shared: any = { sessions: [], working: {}, clients: [], updatedAt: '' }
	ipc.updateState = ((mutator: (state: any) => void) => {
		mutator(shared)
		return shared
	}) as typeof ipc.updateState
	try {
		runtime.handleCommand({
			type: 'client-status',
			sessionId: '04-one',
			pid: 123,
			startedAt: '2026-06-04T12:00:00.000Z',
			updatedAt: '2026-06-04T12:01:00.000Z',
			cwd: '/work',
			versionStatus: 'ready',
			version: 'client123',
		})
		expect(shared.clients).toEqual([{
			pid: 123,
			startedAt: '2026-06-04T12:00:00.000Z',
			updatedAt: '2026-06-04T12:01:00.000Z',
			sessionId: '04-one',
			cwd: '/work',
			versionStatus: 'ready',
			version: 'client123',
			error: undefined,
		}])

		runtime.handleCommand({ type: 'client-exit', pid: 123 })
		expect(shared.clients).toEqual([])
	} finally {
		ipc.updateState = origUpdateState
	}
})


test('/what stores summarizing in shared state and skips duplicate targets', async () => {
	const origUpdateState = ipc.updateState
	const origReadState = ipc.readState
	const origAppendEvent = ipc.appendEvent
	const origResolveTargets = whatSummary.resolveTargets
	const origRun = whatSummary.run
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const shared: any = { sessions: [], working: {}, summarizing: {}, clients: [], updatedAt: '' }
	const events: any[] = []
	const runs: any[] = []
	let release!: () => void
	const done = new Promise<void>((resolve) => { release = resolve })
	ipc.updateState = ((mutator: (state: any) => void) => {
		mutator(shared)
		return shared
	}) as typeof ipc.updateState
	ipc.readState = (() => shared) as typeof ipc.readState
	ipc.appendEvent = (event: any) => { events.push(event) }
	whatSummary.resolveTargets = () => ({ ok: true, ids: ['04-target'] })
	whatSummary.run = (async (opts: any) => {
		runs.push(opts.targetIds)
		await done
		return { renamed: false, targetIds: opts.targetIds }
	}) as typeof whatSummary.run
	try {
		runtime.state.openSessionIds = ['04-requester', '04-target']
		runtime.handleCommand({ type: 'what', sessionId: '04-requester', target: '2' })
		expect(shared.summarizing).toEqual({ '04-target': true })
		runtime.handleCommand({ type: 'what', sessionId: '04-requester', target: '2' })
		expect(runs).toEqual([['04-target']])
		expect(events).toContainEqual(expect.objectContaining({ type: 'info', text: 'Already summarizing: 04-target' }))
		release()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(shared.summarizing).toEqual({})
	} finally {
		ipc.updateState = origUpdateState
		ipc.readState = origReadState
		ipc.appendEvent = origAppendEvent
		whatSummary.resolveTargets = origResolveTargets
		whatSummary.run = origRun
		runtime.state.openSessionIds = origOpenSessionIds
	}
})

test('command errors include the slash command that caused them', () => {
	expect(runtime.formatCommandError('/rename /what', 'Name may contain letters only.')).toBe('/rename: Name may contain letters only.')
	expect(runtime.formatCommandError('/rename /what', '/rename: Name may contain letters only.')).toBe('/rename: Name may contain letters only.')
})

test('pickMostRecentlyClosedSessionId prefers the newest closed session', () => {
	const picked = sessions.pickMostRecentlyClosedSessionId(
		[
			{ id: '04-open', createdAt: '2026-04-13T18:00:00.000Z' },
			{ id: '04-old', createdAt: '2026-04-13T18:01:00.000Z', closedAt: '2026-04-13T18:05:00.000Z' },
			{ id: '04-new', createdAt: '2026-04-13T18:02:00.000Z', closedAt: '2026-04-13T18:06:00.000Z' },
		],
		new Set(['04-open']),
	)

	expect(picked).toBe('04-new')
})

test('pickMostRecentlyClosedSessionId falls back to createdAt when closedAt is missing', () => {
	const picked = sessions.pickMostRecentlyClosedSessionId(
		[
			{ id: '04-a', createdAt: '2026-04-13T18:01:00.000Z' },
			{ id: '04-b', createdAt: '2026-04-13T18:02:00.000Z' },
		],
		new Set(),
	)

	expect(picked).toBe('04-b')
})

test('pickMostRecentlyClosedSessionId returns null when nothing is closed', () => {
	const picked = sessions.pickMostRecentlyClosedSessionId(
		[{ id: '04-open', createdAt: '2026-04-13T18:00:00.000Z' }],
		new Set(['04-open']),
	)

	expect(picked).toBeNull()
})

test('restoredSessionOrder reinserts a resumed tab at its saved position', () => {
	expect(tabs.restoredSessionOrder(['04-left', '04-right'], '04-closed', 2)).toEqual(['04-left', '04-closed', '04-right'])
	expect(tabs.restoredSessionOrder(['04-left', '04-right'], '04-closed', 1)).toEqual(['04-closed', '04-left', '04-right'])
	expect(tabs.restoredSessionOrder(['04-left', '04-right'], '04-closed', 99)).toEqual(['04-left', '04-right', '04-closed'])
	expect(tabs.restoredSessionOrder(['04-left', '04-right'], '04-closed')).toEqual(['04-left', '04-right', '04-closed'])
	expect(tabs.restoredSessionOrder(['04-left', '04-right'], '04-closed', 0)).toEqual(['04-left', '04-right', '04-closed'])
})

test('unchanged rebase apply is a no-op', async () => {
	const events: any[] = []
	const entries: any[] = [{ type: 'user', id: '000001-aaa', parts: [{ type: 'text', text: 'hello' }], ts: '2026-05-25T12:00:00.000Z' }]
	let rewrites = 0
	const origAppendEvent = ipc.appendEvent
	const origLoadHistory = sessions.loadHistory
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origRewriteHistoryForRebase = sessions.rewriteHistoryForRebase
	const origIsWorking = agentLoop.isWorking
	ipc.appendEvent = (event: any) => { events.push(event) }
	sessions.loadHistory = () => entries
	sessions.loadSessionMeta = () => ({ id: 's1', createdAt: '2026-05-25T12:00:00.000Z', currentLog: 'history.asonl' })
	sessions.rewriteHistoryForRebase = (() => {
		rewrites++
		return { oldLog: 'history.asonl', newLog: 'history2.asonl', entryCount: 0 }
	}) as typeof sessions.rewriteHistoryForRebase
	agentLoop.isWorking = () => false
	try {
		runtime.handleCommand({ type: 'rebase-start', sessionId: 's1', requestId: 'r1', clientPid: 123 })
		const start = events.find((event) => event.type === 'rebase-start')
		expect(start?.todo).toContain("'hello'")

		runtime.handleCommand({ type: 'rebase-apply', sessionId: 's1', requestId: 'r1', clientPid: 123, todo: start.todo })
		await Bun.sleep(0)

		expect(rewrites).toBe(0)
		expect(events.find((event) => event.type === 'history-rebased')).toBeUndefined()
		expect(events.find((event) => event.type === 'rebase-result')).toMatchObject({ ok: true, unchanged: true })
	} finally {
		ipc.appendEvent = origAppendEvent
		sessions.loadHistory = origLoadHistory
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.rewriteHistoryForRebase = origRewriteHistoryForRebase
		agentLoop.isWorking = origIsWorking
	}
})


test('rebase edit with unchanged content is a no-op', async () => {
	const events: any[] = []
	const entries: any[] = [{ type: 'user', id: '000001-aaa', parts: [{ type: 'text', text: 'hello' }], ts: '2026-05-25T12:00:00.000Z' }]
	let rewrites = 0
	const origAppendEvent = ipc.appendEvent
	const origLoadHistory = sessions.loadHistory
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origRewriteHistoryForRebase = sessions.rewriteHistoryForRebase
	const origIsWorking = agentLoop.isWorking
	ipc.appendEvent = (event: any) => { events.push(event) }
	sessions.loadHistory = () => entries
	sessions.loadSessionMeta = () => ({ id: 's1', createdAt: '2026-05-25T12:00:00.000Z', currentLog: 'history.asonl' })
	sessions.rewriteHistoryForRebase = (() => {
		rewrites++
		return { oldLog: 'history.asonl', newLog: 'history2.asonl', entryCount: 0 }
	}) as typeof sessions.rewriteHistoryForRebase
	agentLoop.isWorking = () => false
	try {
		runtime.handleCommand({ type: 'rebase-start', sessionId: 's1', requestId: 'r2', clientPid: 123 })
		const start = events.find((event) => event.type === 'rebase-start')
		const todo = String(start.todo).replace('pick 000001-aaa user', 'edit 000001-aaa user')

		runtime.handleCommand({ type: 'rebase-apply', sessionId: 's1', requestId: 'r2', clientPid: 123, todo, edits: { '000001-aaa': 'hello' } })
		await Bun.sleep(0)

		expect(rewrites).toBe(0)
		expect(events.find((event) => event.type === 'history-rebased')).toBeUndefined()
		expect(events.find((event) => event.type === 'rebase-result' && event.requestId === 'r2')).toMatchObject({ ok: true, unchanged: true })
	} finally {
		ipc.appendEvent = origAppendEvent
		sessions.loadHistory = origLoadHistory
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.rewriteHistoryForRebase = origRewriteHistoryForRebase
		agentLoop.isWorking = origIsWorking
	}
})

test('fork command persists one child notice without duplicating bare session ids', () => {
	const parentId = '25-parent'
	const events: any[] = []
	const history: Record<string, any[]> = {}
	const metas: Record<string, SessionMeta> = {
		[parentId]: { id: parentId, workingDir: '/tmp/project', createdAt: '2026-05-21T10:00:00.000Z', model: 'openai/gpt-5' },
	}
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origAppendEvent = ipc.appendEvent
	const origUpdateState = ipc.updateState
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origForkSession = sessions.forkSession
	const origUpdateMeta = sessions.updateMeta
	const origAppendHistorySync = sessions.appendHistorySync
	const origSessionOpenInfo = sessions.sessionOpenInfo
	const origWatchPromptFiles = context.watchPromptFiles

	try {
		runtime.state.openSessionIds = [parentId]
		ipc.appendEvent = (event: any) => { events.push(event) }
		ipc.updateState = () => ({ sessions: [], working: {}, summarizing: {}, updatedAt: '2026-05-21T10:00:00.000Z' })
		context.watchPromptFiles = () => () => {}
		sessions.loadSessionMeta = (id) => metas[id] ?? null
		sessions.forkSession = (sourceId, newId) => {
			const parent = metas[sourceId]!
			const child = { ...parent, id: newId, createdAt: '2026-05-21T10:01:00.000Z', forkedFrom: sourceId }
			metas[newId] = child
			history[newId] = [{ type: 'forked_from', parent: sourceId, ts: child.createdAt }]
			return child
		}
		sessions.updateMeta = (id, patch) => {
			metas[id] = { ...metas[id]!, ...patch }
			return metas[id]!
		}
		sessions.appendHistorySync = (id, entries) => {
			history[id] ??= []
			history[id]!.push(...entries)
		}
		sessions.sessionOpenInfo = (meta) => ({ id: meta.id, tab: 1, name: meta.name ?? meta.id, cwd: meta.workingDir ?? '', model: meta.model })

		;(runtime as any).handleCommand({ type: 'open', sessionId: parentId, forkSessionId: parentId })

		const childId = runtime.state.openSessionIds.find((id) => id !== parentId)!
		expect(childId).toBeTruthy()
		expect(events.map((event) => event.text)).toEqual([`Tab forked to ${childId}.`])
		expect(history[childId]!.filter((entry) => entry.type === 'info').map((entry) => entry.text)).toEqual([`Tab forked from ${parentId}; now writing to ${paths.historyDisplayPath(childId)}`])
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
		ipc.appendEvent = origAppendEvent
		ipc.updateState = origUpdateState
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.forkSession = origForkSession
		sessions.updateMeta = origUpdateMeta
		sessions.appendHistorySync = origAppendHistorySync
		sessions.sessionOpenInfo = origSessionOpenInfo
		context.watchPromptFiles = origWatchPromptFiles
	}
})


test('slash command state changes are persisted as structural history entries', async () => {
	const sessionId = '04-structural-meta'
	const meta: SessionMeta = { id: sessionId, workingDir: '/work', createdAt: '2026-05-21T10:00:00.000Z', model: 'openai/gpt-5.4' }
	const history: any[] = []
	const events: any[] = []
	const origOwnsHostLock = ipc.ownsHostLock
	const origAppendEvent = ipc.appendEvent
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origUpdateMeta = sessions.updateMeta
	const origAppendHistorySync = sessions.appendHistorySync
	const origIsWorking = agentLoop.isWorking
	const origIsHeld = promptQueue.isHeld

	try {
		ipc.ownsHostLock = () => true
		ipc.appendEvent = (event: any) => { events.push(event) }
		sessions.loadSessionMeta = (id) => id === sessionId ? meta : null
		sessions.updateMeta = (_id, patch) => {
			Object.assign(meta, patch)
			return meta
		}
		sessions.appendHistorySync = (_id, entries) => { history.push(...entries) }
		agentLoop.isWorking = () => false
		promptQueue.isHeld = () => false

		await queueRunner.enqueuePrompt(sessionId, '/model gpt-5.5')

		expect(meta.model).toBe('openai/gpt-5.5')
		expect(history.find((entry) => entry.type === 'model')).toMatchObject(
			{ type: 'model', from: 'openai/gpt-5.4', to: 'openai/gpt-5.5', visibility: 'next-user' },
		)
		expect(events.some((event) => event.text?.startsWith('Model changed from'))).toBe(true)
		// Typed slash commands must survive restart for up-arrow recall.
		expect(history.find((entry) => entry.type === 'input_history')).toMatchObject({ type: 'input_history', text: '/model gpt-5.5' })
	} finally {
		ipc.ownsHostLock = origOwnsHostLock
		ipc.appendEvent = origAppendEvent
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.updateMeta = origUpdateMeta
		sessions.appendHistorySync = origAppendHistorySync
		agentLoop.isWorking = origIsWorking
		promptQueue.isHeld = origIsHeld
	}
})

test('open command inherits cwd and model from opener tab', () => {
	const parentId = '04-parent-open'
	const metas: Record<string, SessionMeta> = {
		[parentId]: { id: parentId, workingDir: '/work/parent', createdAt: '2026-05-21T10:00:00.000Z', model: 'openai/gpt-5' },
	}
	const created: SessionMeta[] = []
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origUpdateState = ipc.updateState
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origCreateSession = sessions.createSession
	const origUpdateMeta = sessions.updateMeta
	const origSessionOpenInfo = sessions.sessionOpenInfo
	const origWatchPromptFiles = context.watchPromptFiles
	const origBuildSystemPrompt = context.buildSystemPrompt
	const origEstimateContext = context.estimateContext

	try {
		runtime.state.openSessionIds = [parentId]
		ipc.updateState = () => ({ sessions: [], working: {}, summarizing: {}, updatedAt: '2026-05-21T10:00:00.000Z' })
		context.watchPromptFiles = () => () => {}
		context.buildSystemPrompt = () => ({ text: '', loaded: [], bytes: 0 })
		context.estimateContext = () => ({ used: 0, max: 100, estimated: true })
		sessions.loadSessionMeta = (id) => metas[id] ?? null
		sessions.createSession = (id, meta) => {
			metas[id] = meta
			created.push(meta)
			return meta
		}
		sessions.updateMeta = (id, patch) => {
			metas[id] = { ...metas[id]!, ...patch }
			return metas[id]!
		}
		sessions.sessionOpenInfo = (meta) => ({ id: meta.id, tab: 1, name: meta.name ?? meta.id, cwd: meta.workingDir ?? '', model: meta.model })

		;(runtime as any).handleCommand({ type: 'open', sessionId: parentId })

		expect(created).toHaveLength(1)
		expect(created[0]!.workingDir).toBe('/work/parent')
		expect(created[0]!.model).toBe('openai/gpt-5')
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
		ipc.updateState = origUpdateState
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.createSession = origCreateSession
		sessions.updateMeta = origUpdateMeta
		sessions.sessionOpenInfo = origSessionOpenInfo
		context.watchPromptFiles = origWatchPromptFiles
		context.buildSystemPrompt = origBuildSystemPrompt
		context.estimateContext = origEstimateContext
	}
})


test('shouldAutoContinue resumes only restarted interrupted turns', () => {
	expect(runtime.shouldAutoContinue([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts: '2026-05-27T12:00:00.000Z' },
		{ type: 'log', text: '[restarted]', ts: '2026-05-27T12:00:01.000Z' },
	])).toBe(true)

	expect(runtime.shouldAutoContinue([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts: '2026-05-27T12:00:00.000Z' },
		{ type: 'turn_end', status: 'completed', ts: '2026-05-27T12:00:01.000Z' },
		{ type: 'log', text: '[restarted]', ts: '2026-05-27T12:00:02.000Z' },
	])).toBe(false)

	expect(runtime.shouldAutoContinue([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts: '2026-05-27T12:00:00.000Z' },
	])).toBe(false)
})



test('subagent closes after a clean completion while leave-open and interactive sessions remain', () => {
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent' }, 'completed')).toBe(true)
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent' }, 'aborted')).toBe(false)
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent' }, 'failed')).toBe(false)
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent' }, 'paused')).toBe(false)
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent-leave-open' }, 'completed')).toBe(false)
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'interactive' }, 'completed')).toBe(false)
})

test('queue slash command lists and clears queued prompts', async () => {
	const sessionId = `test-queue-${Date.now().toString(36)}`
	const events: any[] = []
	const origAppendEvent = ipc.appendEvent
	const origOwnsHostLock = ipc.ownsHostLock

	try {
		ipc.ownsHostLock = () => true
		ipc.appendEvent = (event: any) => { events.push(event) }
		promptQueue.append(sessionId, { text: 'first queued', createdAt: '2026-05-20T00:00:00.000Z' })

		expect(await queueRunner.handleQueueSlashCommand(sessionId, '/queue')).toBe(true)
		expect(events.some((event) => event.type === 'info' && event.text.includes('1. first queued'))).toBe(true)

		const longPrompt = `${'x'.repeat(100)}\nsecond line`
		promptQueue.append(sessionId, { text: longPrompt, createdAt: '2026-05-20T00:00:01.000Z' })
		events.length = 0
		expect(await queueRunner.handleQueueSlashCommand(sessionId, '/queue')).toBe(true)
		expect(events.some((event) => event.type === 'info' && event.text.includes(`2. ${longPrompt}`))).toBe(true)
		expect(await queueRunner.handleQueueSlashCommand(sessionId, '/queue clear')).toBe(true)
		expect(promptQueue.load(sessionId)).toEqual([])
		expect(events.some((event) => event.type === 'info' && event.text === 'Queue cleared')).toBe(true)
	} finally {
		ipc.appendEvent = origAppendEvent
		ipc.ownsHostLock = origOwnsHostLock
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})

test('enqueuePrompt stores prompts while session is working', async () => {
	const sessionId = `test-queue-working-${Date.now().toString(36)}`
	const events: any[] = []
	const origAppendEvent = ipc.appendEvent
	const origIsWorking = agentLoop.isWorking
	const origOwnsHostLock = ipc.ownsHostLock

	try {
		ipc.ownsHostLock = () => true
		ipc.appendEvent = (event: any) => { events.push(event) }
		agentLoop.isWorking = () => true

		await queueRunner.enqueuePrompt(sessionId, 'do this later', 'user')

		expect(promptQueue.load(sessionId).map((entry) => entry.text)).toEqual(['do this later'])
		expect(events.some((event) => event.type === 'info' && event.text === 'Queued 1: do this later')).toBe(true)
	} finally {
		ipc.appendEvent = origAppendEvent
		ipc.ownsHostLock = origOwnsHostLock
		agentLoop.isWorking = origIsWorking
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})


test('drained queued prompts keep raw text so slash commands stay commands', async () => {
	const sessionId = `test-queue-raw-${Date.now().toString(36)}`
	const calls: any[] = []
	const origHandlePrompt = runtime.handlePrompt

	try {
		runtime.handlePrompt = async (id, text, label, source, displayText) => {
			calls.push({ id, text, label, source, displayText })
		}
		promptQueue.append(sessionId, {
			text: '/rename after queue',
			source: 'user',
			displayText: '/rename after queue',
			createdAt: '2026-05-20T00:00:00.000Z',
		})

		expect(await queueRunner.runNextQueuedPrompt(sessionId, false)).toBe(true)

		expect(calls).toEqual([{
			id: sessionId,
			text: '/rename after queue',
			label: 'queued',
			source: 'user',
			displayText: '/rename after queue',
		}])
	} finally {
		runtime.handlePrompt = origHandlePrompt
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})
test('working queue slash command does not abort the running turn', async () => {
	const sessionId = `test-queue-working-${Date.now().toString(36)}`
	const events: any[] = []
	let aborts = 0
	const origAppendEvent = ipc.appendEvent
	const origIsWorking = agentLoop.isWorking
	const origAbort = agentLoop.abort
	try {
		ipc.appendEvent = (event: any) => { events.push(event) }
		agentLoop.isWorking = () => true
		agentLoop.abort = () => {
			aborts++
			return true
		}
		promptQueue.append(sessionId, { text: 'queued prompt', createdAt: '2026-05-20T00:00:00.000Z' })

		runtime.handleCommand({ type: 'prompt', sessionId, text: '/queue' })
		await Bun.sleep(0)

		expect(aborts).toBe(0)
		expect(promptQueue.load(sessionId).map((entry) => entry.text)).toEqual(['queued prompt'])
		expect(events.some((event) => event.type === 'info' && event.text === '1. queued prompt')).toBe(true)
	} finally {
		ipc.appendEvent = origAppendEvent
		agentLoop.isWorking = origIsWorking
		agentLoop.abort = origAbort
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})


test('working-safe slash command does not abort the running turn', async () => {
	const sessionId = `test-working-safe-${Date.now().toString(36)}`
	const meta: SessionMeta = {
		id: sessionId,
		createdAt: '2026-05-20T00:00:00.000Z',
		currentLog: 'history.asonl',
		workingDir: '/tmp',
		model: 'openai/gpt-5.5',
	}
	let aborts = 0
	const origOpenSessionIds = [...runtime.state.openSessionIds]
	const origCurrentSessionId = runtime.state.currentSessionId
	const origStopPromptWatch = runtime.state.stopPromptWatch
	const origAppendEvent = ipc.appendEvent
	const origOwnsHostLock = ipc.ownsHostLock
	const origIsWorking = agentLoop.isWorking
	const origAbort = agentLoop.abort
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origUpdateMeta = sessions.updateMeta
	const origSessionOpenInfo = sessions.sessionOpenInfo
	const origWatchPromptFiles = context.watchPromptFiles
	try {
		runtime.state.openSessionIds = [sessionId]
		runtime.state.currentSessionId = sessionId
		runtime.state.stopPromptWatch = null
		ipc.appendEvent = () => {}
		ipc.ownsHostLock = () => true
		agentLoop.isWorking = (id) => id === sessionId
		agentLoop.abort = () => {
			aborts++
			return true
		}
		sessions.loadSessionMeta = (id) => id === sessionId ? meta : null
		sessions.updateMeta = (_id, patch) => { Object.assign(meta, patch) }
		sessions.sessionOpenInfo = (item) => ({ id: item.id, tab: 1, name: item.name, cwd: item.workingDir ?? '', model: item.model })
		context.watchPromptFiles = () => () => {}

		runtime.handleCommand({ type: 'prompt', sessionId, text: '/rename foo bar' })
		await Bun.sleep(0)

		expect(aborts).toBe(0)
		expect(meta.name).toBe('foo bar')
	} finally {
		runtime.state.openSessionIds = origOpenSessionIds
		runtime.state.currentSessionId = origCurrentSessionId
		runtime.state.stopPromptWatch = origStopPromptWatch
		ipc.appendEvent = origAppendEvent
		ipc.ownsHostLock = origOwnsHostLock
		agentLoop.isWorking = origIsWorking
		agentLoop.abort = origAbort
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.updateMeta = origUpdateMeta
		sessions.sessionOpenInfo = origSessionOpenInfo
		context.watchPromptFiles = origWatchPromptFiles
	}
})


test('working queue next reports working without consuming the queue', async () => {
	const sessionId = `test-queue-next-working-${Date.now().toString(36)}`
	const events: any[] = []
	let aborts = 0
	const origAppendEvent = ipc.appendEvent
	const origIsWorking = agentLoop.isWorking
	const origAbort = agentLoop.abort
	try {
		ipc.appendEvent = (event: any) => { events.push(event) }
		agentLoop.isWorking = () => true
		agentLoop.abort = () => {
			aborts++
			return true
		}
		promptQueue.append(sessionId, { text: 'queued prompt', createdAt: '2026-05-20T00:00:00.000Z' })

		runtime.handleCommand({ type: 'prompt', sessionId, text: '/queue next' })
		await Bun.sleep(0)

		expect(aborts).toBe(0)
		expect(promptQueue.load(sessionId).map((entry) => entry.text)).toEqual(['queued prompt'])
		expect(events.some((event) => event.type === 'info' && event.text === 'Session is working')).toBe(true)
	} finally {
		ipc.appendEvent = origAppendEvent
		agentLoop.isWorking = origIsWorking
		agentLoop.abort = origAbort
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})


test('queue paused notice includes truncated preview and queue hint', () => {
	const text = queueRunner.buildQueuePausedNotice([
		{ text: 'first line\nsecond line', createdAt: '2026-05-20T00:00:00.000Z' },
		{ text: 'second prompt', createdAt: '2026-05-20T00:00:01.000Z' },
	])

	expect(text).toBe('Paused. 2 queued prompts are waiting. Next: **first line...**. **ctrl-q** to run queued prompts, `/queue` to show them, `/queue clear` to discard.')
})

test('queue paused notice omits show hint when preview is complete', () => {
	const text = queueRunner.buildQueuePausedNotice([
		{ text: 'short prompt', createdAt: '2026-05-20T00:00:00.000Z' },
		{ text: 'second prompt', createdAt: '2026-05-20T00:00:01.000Z' },
	])

	expect(text).toBe('Paused. 2 queued prompts are waiting. Next: **short prompt**. **ctrl-q** to run queued prompts, `/queue clear` to discard.')
})

test('queue paused notice uses singular pronouns for one prompt', () => {
	const text = queueRunner.buildQueuePausedNotice([
		{ text: 'first line\nsecond line', createdAt: '2026-05-20T00:00:00.000Z' },
	])

	expect(text).toBe('Paused. 1 queued prompt is waiting. Next: **first line...**. **ctrl-q** to run the queued prompt, `/queue` to show it, `/queue clear` to discard it.')
})

test('held queue does not drain after unrelated completed prompt', () => {
	const sessionId = `test-held-${Date.now().toString(36)}`
	try {
		promptQueue.append(sessionId, { text: 'queued prompt', createdAt: '2026-05-20T00:00:01.000Z' })
		promptQueue.setHeld(sessionId, true)

		expect(queueRunner.shouldDrainQueuedPrompt(sessionId, 'completed')).toBe(false)

		promptQueue.setHeld(sessionId, false)
		expect(queueRunner.shouldDrainQueuedPrompt(sessionId, 'completed')).toBe(true)
		expect(queueRunner.shouldDrainQueuedPrompt(sessionId, 'aborted')).toBe(false)
	} finally {
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})


test('continue releases a held queue so completion drains it', async () => {
	const sessionId = `test-continue-held-${Date.now().toString(36)}`
	const calls: any[] = []
	const origHandlePrompt = runtime.handlePrompt
	const origRunAgentLoop = agentLoop.runAgentLoop
	const origIsWorking = agentLoop.isWorking
	const origOwnsHostLock = ipc.ownsHostLock
	try {
		ipc.ownsHostLock = () => true
		agentLoop.isWorking = () => false
		agentLoop.runAgentLoop = async () => 'completed'
		runtime.handlePrompt = async (id, text, label) => {
			calls.push({ id, text, label })
		}
		sessions.createSession(sessionId, {
			id: sessionId,
			createdAt: '2026-05-20T00:00:00.000Z',
			currentLog: 'history.asonl',
			workingDir: '/tmp',
			model: 'openai/gpt-5.5',
		})
		promptQueue.append(sessionId, { text: 'run after continue', createdAt: '2026-05-20T00:00:01.000Z' })
		promptQueue.setHeld(sessionId, true)

		runtime.handleCommand({ type: 'continue', sessionId })
		await Bun.sleep(10)

		expect(calls).toEqual([{ id: sessionId, text: 'run after continue', label: 'queued' }])
		expect(promptQueue.load(sessionId)).toEqual([])
		expect(promptQueue.isHeld(sessionId)).toBe(false)
	} finally {
		runtime.handlePrompt = origHandlePrompt
		agentLoop.runAgentLoop = origRunAgentLoop
		agentLoop.isWorking = origIsWorking
		ipc.ownsHostLock = origOwnsHostLock
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})


test('continue records a resuming notice after a paused turn', async () => {
	const sessionId = `test-continue-resuming-${Date.now().toString(36)}`
	const origRunAgentLoop = agentLoop.runAgentLoop
	const origIsWorking = agentLoop.isWorking
	const origOwnsHostLock = ipc.ownsHostLock
	try {
		ipc.ownsHostLock = () => true
		agentLoop.isWorking = () => false
		agentLoop.runAgentLoop = async () => 'completed'
		sessions.createSession(sessionId, {
			id: sessionId,
			createdAt: '2026-05-20T00:00:00.000Z',
			currentLog: 'history.asonl',
			workingDir: '/tmp',
			model: 'openai/gpt-5.5',
		})
		sessions.appendHistorySync(sessionId, [{ type: 'turn_end', status: 'aborted', abortText: '[paused]', ts: '2026-05-20T00:00:01.000Z' }])

		runtime.handleCommand({ type: 'continue', sessionId })
		await Bun.sleep(10)

		const logs = sessions.loadHistory(sessionId).filter((entry) => entry.type === 'log').map((entry) => entry.text)
		expect(logs).toContain('[resuming]')
	} finally {
		agentLoop.runAgentLoop = origRunAgentLoop
		agentLoop.isWorking = origIsWorking
		ipc.ownsHostLock = origOwnsHostLock
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})


test('pending tools execute before provider replay can repair them as interrupted', async () => {
	const sessionId = `test-pending-runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	const origDispatch = toolRegistry.dispatch
	const origUpdateState = ipc.updateState
	const shared: any = { sessions: [], working: {}, summarizing: {}, updatedAt: '' }
	ipc.updateState = ((mutator: (state: any) => void) => {
		mutator(shared)
		return shared
	}) as typeof ipc.updateState
	toolRegistry.dispatch = async (name, input: any) => `${name}:${input.path}`

	try {
		await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: '/tmp/original' })
		await sessions.appendHistory(sessionId, [
			{ type: 'user', parts: [{ type: 'text', text: 'read' }], ts: '2026-06-18T10:00:00.000Z' },
			{ type: 'tool_call', toolId: 'tool-1', name: 'read', input: { path: 'README.md' }, ts: '2026-06-18T10:00:01.000Z' },
			{ type: 'pending_tools', toolIds: ['tool-1'], cwd: '/tmp/persisted', reason: 'soft-pause', ts: '2026-06-18T10:00:02.000Z' },
		])

		expect(() => apiMessages.toProviderMessages(sessionId, undefined, { prune: false })).toThrow('pending tools')
		expect(await runtime.continuePendingTools(sessionId)).toBe(true)

		const history = sessions.loadHistory(sessionId)
		expect(history.find((entry) => entry.type === 'pending_tools')).toMatchObject({ canceled: true })
		expect(history.find((entry) => entry.type === 'tool_result')).toMatchObject({ type: 'tool_result', toolId: 'tool-1' })
		expect(apiMessages.toProviderMessages(sessionId, undefined, { prune: false }).at(-1)).toEqual({
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'read:README.md' }],
		})
	} finally {
		toolRegistry.dispatch = origDispatch
		ipc.updateState = origUpdateState
		sessions.deleteSession(sessionId)
	}
})

test('empty abort is silent when no turn is working', () => {
	const events: any[] = []
	const origAbort = agentLoop.abort
	const origAppendEvent = ipc.appendEvent
	agentLoop.abort = () => false
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		runtime.handleCommand({ type: 'abort', sessionId: '04-idle', abortText: '' })
		expect(events).toEqual([])
	} finally {
		agentLoop.abort = origAbort
		ipc.appendEvent = origAppendEvent
	}
})


test('recordTabClosed emits info when no turn is working', () => {
	const events: any[] = []
	const origAbort = agentLoop.abort
	const origAppendEvent = ipc.appendEvent
	agentLoop.abort = () => false
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		runtime.recordTabClosed('04-idle')
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: 'info',
			sessionId: '04-idle',
			text: 'Tab closed',
			level: 'info',
		})
	} finally {
		agentLoop.abort = origAbort
		ipc.appendEvent = origAppendEvent
	}
})


test('runCompact emits context estimate for live status line', () => {
	const sessionId = `test-compact-context-${Date.now().toString(36)}`
	const events: any[] = []
	const origAppendEvent = ipc.appendEvent
	const origOwnsHostLock = ipc.ownsHostLock
	const origIsWorking = agentLoop.isWorking

	try {
		ipc.ownsHostLock = () => true
		ipc.appendEvent = (event: any) => { events.push(event) }
		agentLoop.isWorking = () => false
		sessions.createSession(sessionId, {
			id: sessionId,
			workingDir: process.cwd(),
			createdAt: '2026-05-20T12:00:00.000Z',
			model: 'openai/gpt-5',
			context: { used: 999_999, max: 999_999 },
		})
		sessions.appendHistorySync(sessionId, [
			{ type: 'user', parts: [{ type: 'text', text: 'before compact' }], ts: '2026-05-20T12:00:01.000Z' },
			{ type: 'assistant', text: 'reply', ts: '2026-05-20T12:00:02.000Z' },
		])

		runtime.runCompact(sessionId)

		const meta = sessions.loadSessionMeta(sessionId)
		const event = events.find((event) => event.type === 'stream-end' && event.sessionId === sessionId)
		expect(event).toMatchObject({
			type: 'stream-end',
			sessionId,
			contextUsed: meta?.context?.used,
			contextMax: meta?.context?.max,
		})
		expect(meta?.context?.used).not.toBe(999_999)
	} finally {
		ipc.appendEvent = origAppendEvent
		ipc.ownsHostLock = origOwnsHostLock
		agentLoop.isWorking = origIsWorking
		sessions.deleteSession(sessionId)
	}
})

// Model refresh/discovery notice tests live in model-notices.test.ts.

test('resolveResumeTarget matches a closed session by name case-insensitively', () => {
	const picked = sessions.resolveResumeTarget(
		[
			{ id: '04-a', createdAt: '2026-04-13T18:01:00.000Z', name: 'Pause Fix' },
			{ id: '04-b', createdAt: '2026-04-13T18:02:00.000Z', name: 'Other' },
		],
		new Set(),
		'pause fix',
	)

	expect(picked).toBe('04-a')
})

import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

test('spawnSession creates a fresh child with auto-close marker', async () => {
	const base = mkdtempSync(join(tmpdir(), 'hal-spawn-'))
	const prevState = process.env.HAL_STATE_DIR
	process.env.HAL_STATE_DIR = base
	const { sessions } = await import('./sessions.ts')

	try {
		await sessions.createSession('04-parent', {
			id: '04-parent',
			workingDir: '/work/parent',
			createdAt: '2026-04-14T12:00:00.000Z',
			model: 'anthropic/claude-sonnet-4.5',
		})
		tokenCalibration.save(100, 100, 'openai/gpt-5')
		const parent: SessionMeta = {
			id: '04-parent',
			name: 'parent',
			workingDir: '/work/parent',
			model: 'anthropic/claude-sonnet-4.5',
			createdAt: '2026-04-14T12:00:00.000Z',
		}
		const child = await runtime.spawnSession(parent, {
			task: 'Do the thing',
			kind: 'subagent',
			mode: 'fresh',
			model: 'openai/gpt-5',
			cwd: '/work/child',
			title: 'Child tab',
			childSessionId: '04-kid',
		})

		expect(child.model).toBe('openai/gpt-5')
		expect(child.workingDir).toBe('/work/child')
		expect(child.id).toBe('04-kid')
		const meta = sessions.loadSessionMeta(child.id)
		expect(meta?.workingDir).toBe('/work/child')
		expect(meta?.model).toBe('openai/gpt-5')
		expect(meta?.name).toBe('Child tab')
		expect(meta?.parentSessionId).toBe('04-parent')
		expect(meta?.attention).toBe('new')
		const prompt = context.buildSystemPrompt({ model: 'openai/gpt-5', cwd: '/work/child', sessionId: child.id })
		const overheadBytes = prompt.text.length + JSON.stringify(toolRegistry.toToolDefs()).length
		const expected = context.estimateContext([], 'openai/gpt-5', overheadBytes)
		expect(meta?.context).toEqual({ used: expected.used, max: expected.max })
		const history = sessions.loadHistory(child.id)
		expect(history.some((entry) => entry.type === 'info' && entry.text.includes('close itself after sending a handoff'))).toBe(true)
		expect(history.some((entry) => entry.type === 'user' && JSON.stringify(entry).includes('Do the thing'))).toBe(false)
	} finally {
		rmSync(base, { recursive: true, force: true })
		if (prevState === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = prevState
	}
})


test('spawnSession opening summary shows the spawned model, not the default', async () => {
	const base = mkdtempSync(join(tmpdir(), 'hal-spawn-banner-'))
	const prevState = process.env.HAL_STATE_DIR
	process.env.HAL_STATE_DIR = base
	const { sessions } = await import('./sessions.ts')

	try {
		await sessions.createSession('04-parent-banner', {
			id: '04-parent-banner',
			workingDir: '/work/parent',
			createdAt: '2026-04-14T12:00:00.000Z',
			model: 'openai/gpt-5.5',
		})
		const parent = sessions.loadSessionMeta('04-parent-banner')!
		const child = await runtime.spawnSession(parent, {
			task: '',
			kind: 'interactive',
			mode: 'fresh',
			model: 'openai/gpt-5.6-luna',
			cwd: '/work/child',
			childSessionId: '04-kid-banner',
		})

		const history = sessions.loadHistory(child.id)
		const banner = history.find((entry) => entry.type === 'info' && entry.text.includes('Using '))
		expect(banner && banner.type === 'info' ? banner.text : '').toContain('GPT 5.6 Luna')
		expect(banner && banner.type === 'info' ? banner.text : '').toContain('/work/child')
	} finally {
		rmSync(base, { recursive: true, force: true })
		if (prevState === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = prevState
	}
})


test('spawnSession pins the default model when parent has no model', async () => {
	const base = mkdtempSync(join(tmpdir(), 'hal-spawn-default-model-'))
	const prevState = process.env.HAL_STATE_DIR
	process.env.HAL_STATE_DIR = base
	const { sessions } = await import('./sessions.ts')

	try {
		await sessions.createSession('04-parent-default', {
			id: '04-parent-default',
			workingDir: '/work/parent',
			createdAt: '2026-04-14T12:00:00.000Z',
		})
		const parent = sessions.loadSessionMeta('04-parent-default')!
		const child = await runtime.spawnSession(parent, {
			task: 'Do the thing',
			kind: 'subagent',
			mode: 'fresh',
			childSessionId: '04-kid-default',
		})

		expect(child.model).toBe(models.defaultModel())
		expect(sessions.loadSessionMeta(child.id)?.model).toBe(models.defaultModel())
	} finally {
		rmSync(base, { recursive: true, force: true })
		if (prevState === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = prevState
	}
})


test('spawnSession forks with the parent context usage immediately', async () => {
	const base = mkdtempSync(join(tmpdir(), 'hal-spawn-fork-'))
	const prevState = process.env.HAL_STATE_DIR
	process.env.HAL_STATE_DIR = base
	const { sessions } = await import('./sessions.ts')

	try {
		await sessions.createSession('04-parent', {
			id: '04-parent',
			workingDir: '/work/parent',
			createdAt: '2026-04-14T12:00:00.000Z',
			model: 'openai/gpt-5',
			context: { used: 123, max: 456 },
		})
		const parent = sessions.loadSessionMeta('04-parent')!

		const child = await runtime.spawnSession(parent, {
			task: 'Continue from here',
			kind: 'subagent',
			mode: 'fork',
			childSessionId: '04-child',
		})

		expect(sessions.loadSessionMeta(child.id)?.context).toEqual({ used: 123, max: 456 })
	} finally {
		rmSync(base, { recursive: true, force: true })
		if (prevState === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = prevState
	}
})


test('startSpawnedSession dispatches the child prompt directly', async () => {
	const base = mkdtempSync(join(tmpdir(), 'hal-spawn-'))
	const prevState = process.env.HAL_STATE_DIR
	const queued: any[] = []
	const origAppendCommand = ipc.appendCommand
	const origRunAgentLoop = agentLoop.runAgentLoop
	const origOwnsHostLock = ipc.ownsHostLock
	process.env.HAL_STATE_DIR = base
	const { sessions } = await import('./sessions.ts')

	try {
		ipc.appendCommand = (command: any) => {
			queued.push(command)
		}

		ipc.ownsHostLock = () => true
		agentLoop.runAgentLoop = async () => 'completed'
		await sessions.createSession('04-parent', {
			id: '04-parent',
			workingDir: '/work/parent',
			createdAt: '2026-04-14T12:00:00.000Z',
			model: 'anthropic/claude-sonnet-4.5',
		})
		const parent: SessionMeta = {
			id: '04-parent',
			name: 'parent',
			workingDir: '/work/parent',
			model: 'anthropic/claude-sonnet-4.5',
			createdAt: '2026-04-14T12:00:00.000Z',
		}
		const spec = {
			task: 'Do the thing',
			kind: 'subagent' as const,
			mode: 'fresh' as const,
			model: 'openai/gpt-5',
			cwd: '/work/child',
			title: 'Child tab',
		}
		const child = await runtime.spawnSession(parent, spec)
		await runtime.startSpawnedSession(parent, child, spec)

		const history = sessions.loadHistory(child.id)
		expect(history.some((entry) => entry.type === 'user' && JSON.stringify(entry).includes('Do the thing'))).toBe(true)
		expect(history.find((entry) => entry.type === 'input_history')).toMatchObject({
			type: 'input_history',
			text: expect.stringContaining('Task:\nDo the thing'),
		})
		expect(queued).toHaveLength(0)

		const interactiveSpec = {
			task: '',
			kind: 'interactive' as const,
			mode: 'fresh' as const,
			title: 'Scratch tab',
		}
		const interactiveChild = await runtime.spawnSession(parent, interactiveSpec)
		await runtime.startSpawnedSession(parent, interactiveChild, interactiveSpec)
		const interactiveHistory = sessions.loadHistory(interactiveChild.id)
		expect(interactiveHistory.some((entry) => entry.type === 'user')).toBe(false)

		const promptedInteractiveSpec = {
			task: 'MAKE MODEL PICKER GREAT AGAIN',
			kind: 'interactive' as const,
			mode: 'fresh' as const,
			title: 'Prompted tab',
		}
		const promptedInteractiveChild = await runtime.spawnSession(parent, promptedInteractiveSpec)
		await runtime.startSpawnedSession(parent, promptedInteractiveChild, promptedInteractiveSpec)
		const promptedInteractiveHistory = sessions.loadHistory(promptedInteractiveChild.id)
		expect(promptedInteractiveHistory.some((entry) => entry.type === 'user' && JSON.stringify(entry).includes('MAKE MODEL PICKER GREAT AGAIN'))).toBe(true)
		expect(promptedInteractiveHistory.find((entry) => entry.type === 'input_history')).toMatchObject({
			type: 'input_history',
			text: 'MAKE MODEL PICKER GREAT AGAIN',
		})
		expect(queued).toHaveLength(0)
	} finally {
		ipc.appendCommand = origAppendCommand
		agentLoop.runAgentLoop = origRunAgentLoop

		ipc.ownsHostLock = origOwnsHostLock
		rmSync(base, { recursive: true, force: true })
		if (prevState === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = prevState
	}
})
