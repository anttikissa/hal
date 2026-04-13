import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { sessions } from './sessions.ts'
import { replay } from '../session/replay.ts'

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
