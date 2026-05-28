import { expect, test } from 'bun:test'
import { runtime } from './runtime.ts'
import { sessions, type SessionMeta } from './sessions.ts'
import { ipc } from '../ipc.ts'
import { agentLoop } from '../runtime/agent-loop.ts'
import { context } from '../runtime/context.ts'
import { toolRegistry } from '../tools/tool.ts'
import { tokenCalibration } from '../token-calibration.ts'
import { models } from '../models.ts'
import { HAL_DIR } from '../state.ts'
import { config } from '../config.ts'
import { promptQueue } from '../runtime/prompt-queue.ts'
import { paths } from '../utils/paths.ts'

test('runtime exposes in-memory active sessions for eval helpers', () => {
	const origActiveSessions = [...runtime.state.activeSessions]
	try {
		runtime.state.activeSessions = ['04-one', '04-two', '04-three']
		expect(runtime.state.activeSessions[2]).toBe('04-three')
	} finally {
		runtime.state.activeSessions = origActiveSessions
	}
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
	expect(runtime.restoredSessionOrder(['04-left', '04-right'], '04-closed', 2)).toEqual(['04-left', '04-closed', '04-right'])
	expect(runtime.restoredSessionOrder(['04-left', '04-right'], '04-closed', 1)).toEqual(['04-closed', '04-left', '04-right'])
	expect(runtime.restoredSessionOrder(['04-left', '04-right'], '04-closed', 99)).toEqual(['04-left', '04-right', '04-closed'])
	expect(runtime.restoredSessionOrder(['04-left', '04-right'], '04-closed')).toEqual(['04-left', '04-right', '04-closed'])
	expect(runtime.restoredSessionOrder(['04-left', '04-right'], '04-closed', 0)).toEqual(['04-left', '04-right', '04-closed'])
})

test('unchanged rebase apply is a no-op', async () => {
	const events: any[] = []
	const entries: any[] = [{ type: 'user', id: '000001-aaa', parts: [{ type: 'text', text: 'hello' }], ts: '2026-05-25T12:00:00.000Z' }]
	let rewrites = 0
	const origAppendEvent = ipc.appendEvent
	const origLoadHistory = sessions.loadHistory
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origRewriteHistoryForRebase = sessions.rewriteHistoryForRebase
	const origIsActive = agentLoop.isActive
	ipc.appendEvent = (event: any) => { events.push(event) }
	sessions.loadHistory = () => entries
	sessions.loadSessionMeta = () => ({ id: 's1', createdAt: '2026-05-25T12:00:00.000Z', currentLog: 'history.asonl' })
	sessions.rewriteHistoryForRebase = (() => {
		rewrites++
		return { oldLog: 'history.asonl', newLog: 'history2.asonl', entryCount: 0 }
	}) as typeof sessions.rewriteHistoryForRebase
	agentLoop.isActive = () => false
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
		agentLoop.isActive = origIsActive
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
	const origIsActive = agentLoop.isActive
	ipc.appendEvent = (event: any) => { events.push(event) }
	sessions.loadHistory = () => entries
	sessions.loadSessionMeta = () => ({ id: 's1', createdAt: '2026-05-25T12:00:00.000Z', currentLog: 'history.asonl' })
	sessions.rewriteHistoryForRebase = (() => {
		rewrites++
		return { oldLog: 'history.asonl', newLog: 'history2.asonl', entryCount: 0 }
	}) as typeof sessions.rewriteHistoryForRebase
	agentLoop.isActive = () => false
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
		agentLoop.isActive = origIsActive
	}
})

test('fork command persists one child notice without duplicating bare session ids', () => {
	const parentId = '25-parent'
	const events: any[] = []
	const history: Record<string, any[]> = {}
	const metas: Record<string, SessionMeta> = {
		[parentId]: { id: parentId, workingDir: '/tmp/project', createdAt: '2026-05-21T10:00:00.000Z', model: 'openai/gpt-5' },
	}
	const origActiveSessions = [...runtime.state.activeSessions]
	const origAppendEvent = ipc.appendEvent
	const origUpdateState = ipc.updateState
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origForkSession = sessions.forkSession
	const origUpdateMeta = sessions.updateMeta
	const origAppendHistorySync = sessions.appendHistorySync
	const origSessionOpenInfo = sessions.sessionOpenInfo
	const origWatchPromptFiles = context.watchPromptFiles

	try {
		runtime.state.activeSessions = [parentId]
		ipc.appendEvent = (event: any) => { events.push(event) }
		ipc.updateState = () => ({ sessions: [], busy: {}, activity: {}, updatedAt: '2026-05-21T10:00:00.000Z' })
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

		const childId = runtime.state.activeSessions.find((id) => id !== parentId)!
		expect(childId).toBeTruthy()
		expect(events.map((event) => event.text)).toEqual([`Tab forked to ${childId}.`])
		expect(history[childId]!.filter((entry) => entry.type === 'info').map((entry) => entry.text)).toEqual([`Tab forked from ${parentId}; now writing to ${paths.historyDisplayPath(childId)}`])
	} finally {
		runtime.state.activeSessions = origActiveSessions
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
	const origIsActive = agentLoop.isActive
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
		agentLoop.isActive = () => false
		promptQueue.isHeld = () => false

		await runtime.enqueuePrompt(sessionId, '/model gpt-5.5')

		expect(meta.model).toBe('openai/gpt-5.5')
		expect(history).toMatchObject([
			{ type: 'model', from: 'openai/gpt-5.4', to: 'openai/gpt-5.5', visibility: 'next-user' },
		])
		expect(history[0].text).toBeUndefined()
		expect(events.some((event) => event.text?.startsWith('Model changed from'))).toBe(true)
	} finally {
		ipc.ownsHostLock = origOwnsHostLock
		ipc.appendEvent = origAppendEvent
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.updateMeta = origUpdateMeta
		sessions.appendHistorySync = origAppendHistorySync
		agentLoop.isActive = origIsActive
		promptQueue.isHeld = origIsHeld
	}
})

test('open command inherits cwd and model from opener tab', () => {
	const parentId = '04-parent-open'
	const metas: Record<string, SessionMeta> = {
		[parentId]: { id: parentId, workingDir: '/work/parent', createdAt: '2026-05-21T10:00:00.000Z', model: 'openai/gpt-5' },
	}
	const created: SessionMeta[] = []
	const origActiveSessions = [...runtime.state.activeSessions]
	const origUpdateState = ipc.updateState
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origCreateSession = sessions.createSession
	const origUpdateMeta = sessions.updateMeta
	const origSessionOpenInfo = sessions.sessionOpenInfo
	const origWatchPromptFiles = context.watchPromptFiles
	const origBuildSystemPrompt = context.buildSystemPrompt
	const origEstimateContext = context.estimateContext

	try {
		runtime.state.activeSessions = [parentId]
		ipc.updateState = () => ({ sessions: [], busy: {}, activity: {}, updatedAt: '2026-05-21T10:00:00.000Z' })
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
		runtime.state.activeSessions = origActiveSessions
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



test('subagent-autoclose only closes after a clean completion', () => {
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent-autoclose' }, 'completed')).toBe(true)
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent-autoclose' }, 'aborted')).toBe(false)
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent-autoclose' }, 'failed')).toBe(false)
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent-autoclose' }, 'stopped')).toBe(false)
	expect(runtime.shouldCloseSessionAfterGeneration({ spawnKind: 'subagent' }, 'completed')).toBe(false)
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

		expect(await runtime.handleQueueSlashCommand(sessionId, '/queue')).toBe(true)
		expect(events.some((event) => event.type === 'info' && event.text.includes('1. first queued'))).toBe(true)

		expect(await runtime.handleQueueSlashCommand(sessionId, '/queue clear')).toBe(true)
		expect(promptQueue.load(sessionId)).toEqual([])
		expect(events.some((event) => event.type === 'info' && event.text === 'Queue cleared')).toBe(true)
	} finally {
		ipc.appendEvent = origAppendEvent
		ipc.ownsHostLock = origOwnsHostLock
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})

test('enqueuePrompt stores prompts while session is busy', async () => {
	const sessionId = `test-queue-busy-${Date.now().toString(36)}`
	const events: any[] = []
	const origAppendEvent = ipc.appendEvent
	const origIsActive = agentLoop.isActive
	const origOwnsHostLock = ipc.ownsHostLock

	try {
		ipc.ownsHostLock = () => true
		ipc.appendEvent = (event: any) => { events.push(event) }
		agentLoop.isActive = () => true

		await runtime.enqueuePrompt(sessionId, 'do this later', 'user')

		expect(promptQueue.load(sessionId).map((entry) => entry.text)).toEqual(['do this later'])
		expect(events.some((event) => event.type === 'info' && event.text === 'Queued 1: do this later')).toBe(true)
	} finally {
		ipc.appendEvent = origAppendEvent
		ipc.ownsHostLock = origOwnsHostLock
		agentLoop.isActive = origIsActive
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})
test('active queue slash command does not abort the running turn', async () => {
	const sessionId = `test-queue-active-${Date.now().toString(36)}`
	const events: any[] = []
	let aborts = 0
	const origAppendEvent = ipc.appendEvent
	const origIsActive = agentLoop.isActive
	const origAbort = agentLoop.abort
	try {
		ipc.appendEvent = (event: any) => { events.push(event) }
		agentLoop.isActive = () => true
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
		agentLoop.isActive = origIsActive
		agentLoop.abort = origAbort
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})


test('active queue next reports busy without consuming the queue', async () => {
	const sessionId = `test-queue-next-active-${Date.now().toString(36)}`
	const events: any[] = []
	let aborts = 0
	const origAppendEvent = ipc.appendEvent
	const origIsActive = agentLoop.isActive
	const origAbort = agentLoop.abort
	try {
		ipc.appendEvent = (event: any) => { events.push(event) }
		agentLoop.isActive = () => true
		agentLoop.abort = () => {
			aborts++
			return true
		}
		promptQueue.append(sessionId, { text: 'queued prompt', createdAt: '2026-05-20T00:00:00.000Z' })

		runtime.handleCommand({ type: 'prompt', sessionId, text: '/queue next' })
		await Bun.sleep(0)

		expect(aborts).toBe(0)
		expect(promptQueue.load(sessionId).map((entry) => entry.text)).toEqual(['queued prompt'])
		expect(events.some((event) => event.type === 'info' && event.text === 'Session is busy')).toBe(true)
	} finally {
		ipc.appendEvent = origAppendEvent
		agentLoop.isActive = origIsActive
		agentLoop.abort = origAbort
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})


test('queue paused notice includes truncated preview and queue hint', () => {
	const text = runtime.buildQueuePausedNotice([
		{ text: 'first line\nsecond line', createdAt: '2026-05-20T00:00:00.000Z' },
		{ text: 'second prompt', createdAt: '2026-05-20T00:00:01.000Z' },
	])

	expect(text).toBe('Paused. 2 queued prompts are waiting. Next: **first line...**. **ctrl-q** to run queued prompts, `/queue` to show them, `/queue clear` to discard.')
})

test('queue paused notice omits show hint when preview is complete', () => {
	const text = runtime.buildQueuePausedNotice([
		{ text: 'short prompt', createdAt: '2026-05-20T00:00:00.000Z' },
		{ text: 'second prompt', createdAt: '2026-05-20T00:00:01.000Z' },
	])

	expect(text).toBe('Paused. 2 queued prompts are waiting. Next: **short prompt**. **ctrl-q** to run queued prompts, `/queue clear` to discard.')
})

test('queue paused notice uses singular pronouns for one prompt', () => {
	const text = runtime.buildQueuePausedNotice([
		{ text: 'first line\nsecond line', createdAt: '2026-05-20T00:00:00.000Z' },
	])

	expect(text).toBe('Paused. 1 queued prompt is waiting. Next: **first line...**. **ctrl-q** to run the queued prompt, `/queue` to show it, `/queue clear` to discard it.')
})

test('held queue does not drain after unrelated completed prompt', () => {
	const sessionId = `test-held-${Date.now().toString(36)}`
	try {
		promptQueue.append(sessionId, { text: 'queued prompt', createdAt: '2026-05-20T00:00:01.000Z' })
		promptQueue.setHeld(sessionId, true)

		expect(runtime.shouldDrainQueuedPrompt(sessionId, 'completed')).toBe(false)

		promptQueue.setHeld(sessionId, false)
		expect(runtime.shouldDrainQueuedPrompt(sessionId, 'completed')).toBe(true)
		expect(runtime.shouldDrainQueuedPrompt(sessionId, 'aborted')).toBe(false)
	} finally {
		rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
	}
})


test('recordTabClosed emits info when no generation is active', () => {
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
	const origIsActive = agentLoop.isActive

	try {
		ipc.ownsHostLock = () => true
		ipc.appendEvent = (event: any) => { events.push(event) }
		agentLoop.isActive = () => false
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
		agentLoop.isActive = origIsActive
		sessions.deleteSession(sessionId)
	}
})


test('formatModelRefreshMessage summarizes models.dev changes for the user', () => {
	const msg = runtime.formatModelRefreshMessage([
		'gpt-5.5 context 400k → 1050k',
		'new Claude model claude-sonnet-4-7 (1000k)',
	])
	expect(msg).toContain('[models.dev] fetched model metadata')
	expect(msg).toContain('gpt-5.5 context 400k → 1050k')
	expect(msg).toContain('claude-sonnet-4-7')
})


test('formatModelRefreshMessage reports initial models.dev fetch without change list', () => {
	expect(runtime.formatModelRefreshMessage([], 253)).toBe('Fetched recent data from models.dev (253 models)')
})


test('model metadata refresh notice goes only to focused session', async () => {
	const origActiveSessions = [...runtime.state.activeSessions]
	const origCurrentSessionId = runtime.state.currentSessionId
	const origRefreshModels = models.refreshModels
	const origAppendHistorySync = sessions.appendHistorySync
	const origAppendEvent = ipc.appendEvent
	const histories: any[] = []
	const events: any[] = []

	runtime.state.activeSessions = ['04-left', '04-current', '04-right']
	runtime.state.currentSessionId = '04-current'
	models.refreshModels = async () => ({
		fetched: true,
		hadCache: true,
		changes: ['new Claude model claude-opus-4-7 (1000k)'],
		modelCount: 123,
		previous: {},
		next: {},
	})
	sessions.appendHistorySync = (sessionId: string, entries: any[]) => {
		histories.push({ sessionId, entries })
	}
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		await runtime.refreshModelMetadata()
		expect(histories.map((item) => item.sessionId)).toEqual(['04-current'])
		expect(events.map((item) => item.sessionId)).toEqual(['04-current'])
		expect(events[0]).toMatchObject({ type: 'info', text: expect.stringContaining('[models.dev] fetched model metadata') })
	} finally {
		runtime.state.activeSessions = origActiveSessions
		runtime.state.currentSessionId = origCurrentSessionId
		models.refreshModels = origRefreshModels
		sessions.appendHistorySync = origAppendHistorySync
		ipc.appendEvent = origAppendEvent
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
		const outside = runtime.buildAliasUpdateSuggestionText(updates, '/work/project')
		expect(outside).toContain('openai**, **gpt')
		expect(outside).toContain('openai/gpt-5.4')
		expect(outside).toContain('openai/gpt-5.5')
		expect(outside).toContain("config.ason sets the default model to **gpt**, which currently maps to **openai/gpt-5.5**.")
		expect(outside).toContain('spawn a subagent in ~/.hal')

		const inside = runtime.buildAliasUpdateSuggestionText(updates, HAL_DIR)
		expect(inside).toContain('update those aliases in ~/.hal')
		expect(inside).not.toContain('spawn a subagent')
	} finally {
		config.data = origConfigData
	}
})


test('suggestAliasUpdates emits one synthetic notice, preferring an open ~/.hal tab', () => {
	const origActiveSessions = [...runtime.state.activeSessions]
	const origAliasUpdateSuggestions = models.aliasUpdateSuggestions
	const origLoadSessionMeta = sessions.loadSessionMeta
	const origAppendHistorySync = sessions.appendHistorySync
	const origAppendEvent = ipc.appendEvent
	const histories: any[] = []
	const events: any[] = []

	runtime.state.activeSessions = ['04-work', '04-hal', '04-other']
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
		runtime.suggestAliasUpdates({}, {})
		expect(histories).toHaveLength(1)
		expect(events).toHaveLength(1)
		expect(histories[0].sessionId).toBe('04-hal')
		expect(events[0]).toMatchObject({ type: 'response', sessionId: '04-hal', synthetic: true })
		expect(events[0].text).toContain('update those aliases in ~/.hal')
	} finally {
		runtime.state.activeSessions = origActiveSessions
		models.aliasUpdateSuggestions = origAliasUpdateSuggestions
		sessions.loadSessionMeta = origLoadSessionMeta
		sessions.appendHistorySync = origAppendHistorySync
		ipc.appendEvent = origAppendEvent
	}
})


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
			kind: 'subagent-autoclose',
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
	} finally {
		ipc.appendCommand = origAppendCommand
		agentLoop.runAgentLoop = origRunAgentLoop

		ipc.ownsHostLock = origOwnsHostLock
		rmSync(base, { recursive: true, force: true })
		if (prevState === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = prevState
	}
})
