import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { sessions } from './sessions.ts'
import { replay } from '../session/replay.ts'
import { ipc } from '../ipc.ts'

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
		busy: {},
		activity: {},
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
	expect(live.blocks[0]?.streaming).toBeUndefined()

	sessions.clearLive(id)
	expect(sessions.loadLive(id).blocks).toEqual([])
})


test('sessionOpenInfo includes a 1-based tab number from open order', () => {
	const info = sessions.sessionOpenInfo({
		id: '04-middle',
		workingDir: '/work',
	}, 31)

	expect(info).toMatchObject({
		id: '04-middle',
		tab: 32,
	})
})


test('live snapshot links assistant chunks across info interruptions', async () => {
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
	expect(live.blocks).toHaveLength(3)
	expect(live.blocks[0]).toMatchObject({ type: 'assistant', text: 'hello ' })
	expect(live.blocks[1]).toMatchObject({ type: 'info', text: 'system.md was reloaded' })
	expect(live.blocks[2]).toMatchObject({ type: 'assistant', text: 'world' })
	expect((live.blocks[0] as any).id).toEqual(expect.any(String))
	expect((live.blocks[2] as any).continue).toBe((live.blocks[0] as any).id)
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
	expect(newMsgs[0]).toEqual({ type: 'forked_from', parent: parentId, ts: nowTs })
	expect(newMsgs[1]).toEqual({ type: 'reset', ts: nowTs })
})
