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

afterEach(() => {
	for (const id of createdIds.splice(0)) sessions.deleteSession(id)
})

test('createSession and loadHistory round-trip', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [{ role: 'user', content: 'hello', ts: new Date().toISOString() }])

	const result = sessions.loadHistory(id)
	expect(result).toHaveLength(1)
	expect(result[0]?.content).toBe('hello')
})

test('deleteSession cleans up', async () => {
	const id = await makeSession()
	sessions.deleteSession(id)
	createdIds.pop() // already deleted
	const result = sessions.loadHistory(id)
	expect(result).toHaveLength(0)
})


test('rotateLog switches new writes to history2.asonl', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [{ role: 'user', content: 'old', ts: new Date().toISOString() }])

	const nextLog = await sessions.rotateLog(id)
	await sessions.appendHistory(id, [{ role: 'user', content: 'new', ts: new Date().toISOString() }])

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
	await sessions.appendHistory(id, [{ role: 'user', content: 'one', ts: new Date().toISOString() }])
	expect(await sessions.rotateLog(id)).toBe('history2.asonl')

	await sessions.appendHistory(id, [{ role: 'user', content: 'two', ts: new Date().toISOString() }])
	expect(await sessions.rotateLog(id)).toBe('history3.asonl')
})

test('loadHistory reads from current log after rotation', async () => {
	const id = await makeSession()
	await sessions.appendHistory(id, [{ role: 'user', content: 'old', ts: new Date().toISOString() }])
	await sessions.rotateLog(id)
	await sessions.appendHistory(id, [{ role: 'user', content: 'new context', ts: new Date().toISOString() }])

	const result = sessions.loadHistory(id)
	expect(result).toHaveLength(1)
	expect(result[0]?.content).toBe('new context')
})

test('compact-style rotation preserves forked_from entry', async () => {
	const parentId = await makeSession()
	const childId = await makeSession()
	const oldTs = new Date(Date.now() - 1000).toISOString()
	const nowTs = new Date().toISOString()

	await sessions.appendHistory(parentId, [
		{ role: 'user', content: 'parent msg', ts: oldTs },
		{ role: 'assistant', text: 'parent reply', ts: oldTs },
	])

	await sessions.appendHistory(childId, [{ type: 'forked_from', parent: parentId, ts: nowTs }])
	await sessions.appendHistory(childId, [
		{ role: 'user', content: 'child msg', ts: nowTs },
		{ role: 'assistant', text: 'child reply', ts: nowTs },
	])

	const msgs = sessions.loadHistory(childId)
	const context = replay.buildCompactionContext(childId, msgs)
	await sessions.rotateLog(childId)
	const forkEntry = msgs[0]?.type === 'forked_from' ? [msgs[0]] : []
	await sessions.appendHistory(childId, [
		...forkEntry,
		{ role: 'user', content: '[system] compacted', ts: new Date().toISOString() },
		{ role: 'user', content: context, ts: new Date().toISOString() },
	])

	const newMsgs = sessions.loadHistory(childId)
	expect(newMsgs[0]?.type).toBe('forked_from')
	expect(newMsgs[0]?.parent).toBe(parentId)

	const allMsgs = sessions.loadAllHistory(childId)
	const texts = allMsgs.map((m) => m.content ?? m.text ?? '').filter(Boolean)
	expect(texts.some((text) => String(text).includes('parent msg'))).toBe(true)
})
