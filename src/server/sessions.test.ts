import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { sessions } from './sessions.ts'
import { replay } from './session/replay.ts'
import { ipc } from './file-ipc.ts'
import { models } from '../common/models.ts'

const createdIds: string[] = []

function uniqueId(): string {
	return `test-compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function makeSession(): Promise<string> {
	const id = uniqueId()
	createdIds.push(id)
	await sessions.createSession(id, {
		id,
		createdAt: new Date().toISOString(),
		workingDir: process.cwd(),
	})
	return id
}

function userEntry(text: string, ts: string) {
	return { type: 'user' as const, parts: [{ type: 'text' as const, text }], ts }
}

function entryText(entry: any): string {
	if (entry?.type === 'user') return entry.parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('')
	return typeof entry?.text === 'string' ? entry.text : ''
}

afterEach(() => {
	for (const id of createdIds.splice(0)) sessions.deleteSession(id)
})


test('loadSessionList reads rich sessions from shared state', () => {
	const origReadState = ipc.readState
	ipc.readState = () => ({
		sessions: [{ id: 'new', tab: 1, cwd: '/tmp/new' }],
		working: {},
		updatedAt: '2026-04-24T11:00:00.000Z',
	})
	try {
		expect(sessions.loadSessionList()).toEqual(['new'])
	} finally {
		ipc.readState = origReadState
	}
})

test('createSession and loadHistory round-trip', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [userEntry('hello', new Date().toISOString())])

	const result = sessions.loadHistory(id)
	expect(result).toHaveLength(1)
	expect(entryText(result[0])).toBe('hello')
})


test('appendHistory writes id, omits undefined fields, and persists trusted usage bars', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [{ type: 'log', id: '000001-aaa', text: 'hello', level: undefined, usageBars: true, ts: '2026-05-25T10:00:00.000Z' }])

	const text = readFileSync(`${sessions.sessionDir(id)}/history.asonl`, 'utf-8')

	expect(text).toContain("id: '000001-aaa'")
	expect(text).toContain('usageBars: true')
	expect(text).not.toContain('undefined')
})


test('appendHistory repairs duplicate ids before writing', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [
		{ type: 'user', id: '000001-aaa', parts: [{ type: 'text', text: 'first' }], ts: '2026-05-25T10:00:00.000Z' },
		{ type: 'assistant', id: '000001-aaa', text: 'second', ts: '2026-05-25T10:00:00.000Z' },
	])
	await sessions.appendHistory(id, [{ type: 'user', id: '000001-aaa', parts: [{ type: 'text', text: 'third' }], ts: '2026-05-25T10:00:00.000Z' }])

	const ids = sessions.loadHistory(id).map((entry) => entry.id)

	expect(new Set(ids).size).toBe(ids.length)
	expect(ids[0]).toBe('000001-aaa')
})

test('pending tools marker persists and resolves across reload-style reads', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [
		userEntry('run tool', '2026-05-25T10:00:00.000Z'),
		{ type: 'tool_call', toolId: 'tool-1', name: 'read', input: { path: 'README.md' }, blobId: 'blob-1', ts: '2026-05-25T10:00:01.000Z' },
		{ type: 'pending_tools', toolIds: ['tool-1'], cwd: '/tmp/work', model: 'openai/gpt-5', reason: 'soft-pause', ts: '2026-05-25T10:00:02.000Z' },
	])

	const pending = sessions.findPendingTools(id)
	expect(pending).toMatchObject({ cwd: '/tmp/work', toolIds: ['tool-1'] })
	expect(pending?.toolCalls).toEqual([{ id: 'tool-1', name: 'read', input: { path: 'README.md' }, blobId: 'blob-1' }])

	expect(sessions.resolvePendingTools(id, pending!.id)).toBe(true)
	expect(sessions.findPendingTools(id)).toBeNull()
	expect(sessions.loadHistory(id).find((entry) => entry.type === 'pending_tools')).toMatchObject({ canceled: true })
})


test('cancelTailTurn marks last prompt and partial output canceled in current history', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [
		userEntry('old prompt', '2026-05-25T10:00:00.000Z'),
		{ type: 'turn_end', status: 'aborted', ts: '2026-05-25T10:00:01.000Z' },
	])
	sessions.applyLiveEvent(id, {
		type: 'stream-delta',
		sessionId: id,
		channel: 'assistant',
		text: 'partial answer',
		model: 'openai/gpt-5.5',
		createdAt: '2026-05-25T10:00:02.000Z',
	})

	const result = sessions.cancelTailTurn(id)
	const history = sessions.loadHistory(id)

	expect(result).toMatchObject({ logName: 'history.asonl', entryCount: 2 })
	expect(history).toMatchObject([
		{ type: 'user', canceled: true },
		{ type: 'assistant', text: 'partial answer', model: 'openai/gpt-5.5', canceled: true },
	])
	expect(history.some((entry) => entry.type === 'turn_end')).toBe(false)
	expect(readFileSync(`${sessions.sessionDir(id)}/history.asonl`, 'utf-8')).toContain('canceled: true')
})


test('cancelTailTurn cancels read-only tool tails', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [
		userEntry('old prompt', '2026-05-25T10:00:00.000Z'),
		{ type: 'tool_call', toolId: 'read-1', name: 'read', input: { path: 'README.md' }, ts: '2026-05-25T10:00:01.000Z' },
		{ type: 'tool_result', toolId: 'read-1', output: 'file contents', ts: '2026-05-25T10:00:02.000Z' },
		{ type: 'turn_end', status: 'aborted', ts: '2026-05-25T10:00:03.000Z' },
	])

	expect(sessions.cancelTailTurn(id)).toMatchObject({ logName: 'history.asonl', entryCount: 3 })
	expect(sessions.loadHistory(id)).toMatchObject([
		{ type: 'user', canceled: true },
		{ type: 'tool_call', name: 'read', canceled: true },
		{ type: 'tool_result', toolId: 'read-1', canceled: true },
	])
})

test('forkSession appends fork markers to parent and child history', async () => {
	const parentId = await makeSession()
	const childId = uniqueId()
	createdIds.push(childId)

	const child = sessions.forkSession(parentId, childId)

	expect(child.forkedFrom).toBe(parentId)
	expect(sessions.loadHistory(parentId)).toMatchObject([{ type: 'forked_to', child: childId }])
	expect(sessions.loadHistory(childId)).toMatchObject([{ type: 'forked_from', parent: parentId }])
})


test('forkSession names child as a lowercase fork of a named parent', async () => {
	const parentId = await makeSession()
	const childId = uniqueId()
	createdIds.push(childId)
	sessions.updateMeta(parentId, { name: 'pause fix' })

	const child = sessions.forkSession(parentId, childId)

	expect(child.name).toBe('fork of pause fix')
})


test('updateMeta writes closed session metadata', async () => {
	const id = await makeSession()
	sessions.deactivateSession(id)

	sessions.updateMeta(id, { name: 'closed summary' })

	expect(sessions.loadSessionMeta(id)?.name).toBe('closed summary')
})

test('deleteSession cleans up', async () => {
	const id = await makeSession()
	sessions.deleteSession(id)
	createdIds.pop() // already deleted
	const result = sessions.loadHistory(id)
	expect(result).toHaveLength(0)
})

test('live snapshot stores uncommitted streaming blocks', async () => {
	const id = await makeSession()
	sessions.applyLiveEvent(id, {
		type: 'stream-delta',
		sessionId: id,
		channel: 'assistant',
		text: 'hel',
		createdAt: '2026-04-09T20:01:00.000Z',
	})
	sessions.applyLiveEvent(id, {
		type: 'stream-delta',
		sessionId: id,
		channel: 'assistant',
		text: 'lo',
		createdAt: '2026-04-09T20:01:01.000Z',
	})
	sessions.applyLiveEvent(id, {
		type: 'tool-call',
		sessionId: id,
		toolId: 'tool-1',
		name: 'read',
		input: { path: 'notes.txt' },
		blobId: '000001-abc',
		createdAt: '2026-04-09T20:01:02.000Z',
	})

	const live = sessions.loadLive(id)
	expect(live.blocks).toMatchObject([
		{ type: 'assistant', text: 'hello', ts: Date.parse('2026-04-09T20:01:00.000Z') },
		{ type: 'tool', toolId: 'tool-1', name: 'read', blobId: '000001-abc', input: { path: 'notes.txt' } },
	])
	expect(live.blocks[0]?.type === 'assistant' ? live.blocks[0].streaming : undefined).toBeUndefined()

	sessions.clearLive(id)
	expect(sessions.loadLive(id).blocks).toEqual([])
})


test('sessionOpenInfo includes tab number and effective model', () => {
	const info = sessions.sessionOpenInfo({
		id: '04-middle',
		workingDir: '/work',
	}, 31)

	expect(info).toMatchObject({
		id: '04-middle',
		tab: 32,
		model: models.defaultModel(),
	})
})


test('live snapshot preserves assistant chunks around info events', async () => {
	const id = await makeSession()
	sessions.applyLiveEvent(id, {
		type: 'stream-delta',
		sessionId: id,
		channel: 'assistant',
		text: 'hello ',
		createdAt: '2026-04-09T20:01:00.000Z',
	})
	sessions.applyLiveEvent(id, {
		type: 'info',
		sessionId: id,
		text: 'system.md was reloaded',
		createdAt: '2026-04-09T20:01:01.000Z',
	})
	sessions.applyLiveEvent(id, {
		type: 'stream-delta',
		sessionId: id,
		channel: 'assistant',
		text: 'world',
		createdAt: '2026-04-09T20:01:02.000Z',
	})

	const live = sessions.loadLive(id)
	expect(live.blocks).toMatchObject([
		{ type: 'assistant', text: 'hello ' },
		{ type: 'log', text: 'system.md was reloaded' },
		{ type: 'assistant', text: 'world' },
	])
})


test('live snapshot stores tool results on existing tool blocks', async () => {
	const id = await makeSession()
	sessions.applyLiveEvent(id, {
		type: 'tool-call',
		sessionId: id,
		toolId: 'tool-1',
		name: 'edit',
		input: { path: 'notes.txt' },
		blobId: '000001-abc',
		createdAt: '2026-04-09T20:01:00.000Z',
	})
	sessions.applyLiveEvent(id, {
		type: 'tool-result',
		sessionId: id,
		toolId: 'tool-1',
		blobId: '000001-abc',
		output: 'preview only',
		createdAt: '2026-04-09T20:01:01.000Z',
	})

	const live = sessions.loadLive(id)
	expect(live.blocks).toMatchObject([
		{ type: 'tool', toolId: 'tool-1', name: 'edit', blobId: '000001-abc', output: 'preview only' },
	])
})


test('live snapshot keeps blob metadata for response errors', async () => {
	const id = await makeSession()
	sessions.applyLiveEvent(id, {
		type: 'response',
		sessionId: id,
		isError: true,
		text: '503:\nOur servers are currently overloaded. Please try again later.',
		blobId: '000003-err',
		createdAt: '2026-04-09T20:01:01.000Z',
	})

	const live = sessions.loadLive(id)
	expect(live.blocks).toMatchObject([
		{ type: 'error', text: '503:\nOur servers are currently overloaded. Please try again later.', blobId: '000003-err', sessionId: id },
	])
})

test('rotateLog switches new writes to history2.asonl', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [userEntry('old', new Date().toISOString())])

	const nextLog = await sessions.rotateLog(id)
	await sessions.appendHistory(id, [userEntry('new', new Date().toISOString())])

	expect(nextLog).toBe('history2.asonl')
	expect(existsSync(`${sessions.sessionDir(id)}/history.asonl`)).toBe(true)
	expect(existsSync(`${sessions.sessionDir(id)}/history2.asonl`)).toBe(true)

	const oldLog = readFileSync(`${sessions.sessionDir(id)}/history.asonl`, 'utf-8')
	const newLog = readFileSync(`${sessions.sessionDir(id)}/history2.asonl`, 'utf-8')
	expect(oldLog).toContain('old')
	expect(oldLog).not.toContain('new')
	expect(newLog).toContain('new')
})

test('rotateLog increments history log number', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [userEntry('one', new Date().toISOString())])
	expect(await sessions.rotateLog(id)).toBe('history2.asonl')

	await sessions.appendHistory(id, [userEntry('two', new Date().toISOString())])
	expect(await sessions.rotateLog(id)).toBe('history3.asonl')
})

test('loadHistory reads from current log after rotation', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [userEntry('old', new Date().toISOString())])
	await sessions.rotateLog(id)
	await sessions.appendHistory(id, [userEntry('new context', new Date().toISOString())])

	const result = sessions.loadHistory(id)
	expect(result).toHaveLength(1)
	expect(entryText(result[0])).toBe('new context')
})


test('loadHistoryLog can read a bounded log prefix after later appends', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [userEntry('old', new Date().toISOString())])
	const result = sessions.rewriteHistoryForRebase(id, [userEntry('rebased', new Date().toISOString())])
	await sessions.appendHistory(id, [userEntry('queued later', new Date().toISOString())])

	const prefix = sessions.loadHistoryLog(id, result.newLog, result.entryCount)

	expect(prefix.map(entryText).filter(Boolean)).toEqual(['rebased'])
	expect(sessions.loadHistory(id).map(entryText).filter(Boolean)).toEqual(['rebased', 'queued later'])
})

test('compact-style rotation preserves forked_from entry', async () => {
	const parentId = await makeSession()
	const childId = await makeSession()
	const oldTs = new Date(Date.now() - 1000).toISOString()
	const nowTs = new Date().toISOString()

	await sessions.appendHistory(parentId, [
		userEntry('parent msg', oldTs),
		{ type: 'assistant', text: 'parent reply', ts: oldTs },
	])

	await sessions.appendHistory(childId, [{ type: 'forked_from', parent: parentId, ts: nowTs }])
	await sessions.appendHistory(childId, [
		userEntry('child msg', nowTs),
		{ type: 'assistant', text: 'child reply', ts: nowTs },
	])

	const msgs = sessions.loadHistory(childId)
	const context = replay.buildCompactionContext(childId, msgs)
	await sessions.rotateLog(childId)
	const forkEntry = msgs[0]?.type === 'forked_from' ? [msgs[0]] : []
	await sessions.appendHistory(childId, [
		...forkEntry,
		userEntry('[system] compacted', new Date().toISOString()),
		userEntry(context, new Date().toISOString()),
	])

	const newMsgs = sessions.loadHistory(childId)
	const forkedFrom = newMsgs[0]
	expect(forkedFrom?.type).toBe('forked_from')
	expect(forkedFrom && forkedFrom.type === 'forked_from' ? forkedFrom.parent : undefined).toBe(parentId)

	const allMsgs = sessions.loadAllHistory(childId)
	const texts = allMsgs.map((m) => entryText(m)).filter(Boolean)
	expect(texts.some((text) => text.includes('parent msg'))).toBe(true)
})


test('tailTurnState uses turn_end as the finished-turn boundary', () => {
	const entries: any[] = [
		userEntry('hello', '2026-05-27T12:00:00.000Z'),
		{ type: 'assistant', text: 'done', ts: '2026-05-27T12:00:01.000Z' },
		{ type: 'turn_end', status: 'completed', ts: '2026-05-27T12:00:02.000Z' },
	]

	expect(sessions.tailTurnState(entries)).toMatchObject({ interrupted: false, interruptedTools: [], ended: { type: 'turn_end', status: 'completed' } })
})


test('tailTurnState treats content after the last turn_end as interrupted', () => {
	const entries: any[] = [
		{ type: 'turn_end', status: 'completed', ts: '2026-05-27T12:00:00.000Z' },
		{ type: 'assistant', text: 'partial', ts: '2026-05-27T12:00:01.000Z' },
		{ type: 'tool_call', toolId: 'call_1', name: 'bash', ts: '2026-05-27T12:00:02.000Z' },
	]

	expect(sessions.tailTurnState(entries)).toMatchObject({ interrupted: true, interruptedTools: [{ name: 'bash', id: 'call_1' }] })
})


test('reset-style rotation preserves forked_from entry and writes a reset marker', async () => {
	const parentId = await makeSession()
	const childId = await makeSession()
	const nowTs = new Date().toISOString()

	await sessions.appendHistory(childId, [{ type: 'forked_from', parent: parentId, ts: nowTs }])
	await sessions.appendHistory(childId, [userEntry('old prompt', nowTs)])

	await sessions.rotateLog(childId)
	await sessions.appendHistory(childId, [
		{ type: 'forked_from', parent: parentId, ts: nowTs },
		{ type: 'reset', ts: nowTs },
		userEntry('[system] Session was reset. Previous conversation: history.asonl', nowTs),
	])

	const newMsgs = sessions.loadHistory(childId)
	expect(newMsgs[0]).toMatchObject({ type: 'forked_from', parent: parentId, ts: nowTs })
	expect(newMsgs[1]).toMatchObject({ type: 'reset', ts: nowTs })
})
