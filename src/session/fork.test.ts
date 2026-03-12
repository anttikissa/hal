import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { sessionDir, ensureDir } from '../state.ts'
import { appendHistory, readHistory, loadApiMessages, loadAllHistory, buildCompactionContext, type Message } from './history.ts'
import { forkSession, rotateLog } from './session.ts'
import { stringify, parseAll } from '../utils/ason.ts'

const createdIds: string[] = []

function tempSession(): string {
	const id = `t-${randomBytes(4).toString('hex')}`
	createdIds.push(id)
	const dir = sessionDir(id)
	ensureDir(dir)
	writeFileSync(join(dir, 'session.ason'), stringify({ id, workingDir: '/tmp', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: 'history.asonl' }) + '\n')
	return id
}

afterEach(() => {
	for (const id of createdIds) {
		const dir = sessionDir(id)
		if (existsSync(dir)) rmSync(dir, { recursive: true })
	}
	createdIds.length = 0
})

describe('forkSession', () => {
	test('creates new session with forked_from entry', async () => {
		const parentId = tempSession()
		const ts = new Date().toISOString()
		await appendHistory(parentId, [
			{ role: 'user', content: 'hello', ts } as Message,
			{ role: 'assistant', content: 'hi there', ts } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		// Child session dir exists
		expect(existsSync(sessionDir(childId))).toBe(true)

		// Child has forked_from as first entry
		const raw = readFileSync(join(sessionDir(childId), 'history.asonl'), 'utf-8')
		const entries = parseAll(raw)
		expect(entries[0]).toMatchObject({ type: 'forked_from', parent: parentId })
	})

	test('child has session.ason with log field', async () => {
		const parentId = tempSession()
		await appendHistory(parentId, [
			{ role: 'user', content: 'hello', ts: new Date().toISOString() } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		const metaRaw = readFileSync(join(sessionDir(childId), 'session.ason'), 'utf-8')
		const meta = parseAll(metaRaw)[0] as any
		expect(meta.log).toBe('history.asonl')
		expect(meta.id).toBe(childId)
	})

	test('loadApiMessages on child includes parent history', async () => {
		const parentId = tempSession()
		const ts = new Date(Date.now() - 1000).toISOString()
		await appendHistory(parentId, [
			{ role: 'user', content: 'parent message', ts } as Message,
			{ role: 'assistant', text: 'parent reply', ts } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		// Add a message in the child
		await appendHistory(childId, [
			{ role: 'user', content: 'child message', ts } as Message,
		])

		const apiMsgs = await loadApiMessages(childId)
		const texts = apiMsgs.map((m: any) => {
			if (typeof m.content === 'string') return m.content
			if (Array.isArray(m.content)) {
				const t = m.content.find((b: any) => b.type === 'text')
				return t?.text ?? ''
			}
			return ''
		})

		expect(texts).toContain('parent message')
		expect(texts).toContain('parent reply')
		expect(texts).toContain('child message')
	})

	test('child and parent diverge independently', async () => {
		const parentId = tempSession()
		const ts1 = new Date(Date.now() - 1000).toISOString()
		await appendHistory(parentId, [
			{ role: 'user', content: 'shared', ts: ts1 } as Message,
			{ role: 'assistant', text: 'shared reply', ts: ts1 } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		// Add different messages to parent and child — with later timestamps
		const ts2 = new Date().toISOString()
		await appendHistory(parentId, [
			{ role: 'user', content: 'parent only', ts: ts2 } as Message,
		])
		await appendHistory(childId, [
			{ role: 'user', content: 'child only', ts: ts2 } as Message,
		])

		const parentMsgs = await loadApiMessages(parentId)
		const childMsgs = await loadApiMessages(childId)

		const parentTexts = parentMsgs.map((m: any) => typeof m.content === 'string' ? m.content : '')
		const childTexts = childMsgs.map((m: any) => typeof m.content === 'string' ? m.content : '')

		// Both have shared history
		expect(parentTexts).toContain('shared')
		expect(childTexts).toContain('shared')

		// Each has its own divergent message
		expect(parentTexts).toContain('parent only')
		expect(parentTexts).not.toContain('child only')

		expect(childTexts).toContain('child only')
		expect(childTexts).not.toContain('parent only')
	})

	test('loadApiMessages strips thinking signatures from parent messages', async () => {
		const parentId = tempSession()
		const ts = new Date(Date.now() - 1000).toISOString()
		await appendHistory(parentId, [
			{ role: 'user', content: 'hello', ts } as Message,
			{ role: 'assistant', text: 'reply', thinkingText: 'deep thought', thinkingSignature: 'sig-parent', ts } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		await appendHistory(childId, [
			{ role: 'user', content: 'child question', ts: new Date().toISOString() } as Message,
		])

		const apiMsgs = await loadApiMessages(childId)
		const assistantMsg = apiMsgs.find((m: any) => m.role === 'assistant')
		expect(assistantMsg).toBeTruthy()

		// Parent's thinking block should NOT be included (signature is invalid in fork context)
		const hasThinking = assistantMsg.content.some((b: any) => b.type === 'thinking')
		expect(hasThinking).toBe(false)

		// But the text reply should still be there
		const hasText = assistantMsg.content.some((b: any) => b.type === 'text' && b.text === 'reply')
		expect(hasText).toBe(true)
	})

	test('compaction preserves forked_from entry', async () => {
		const parentId = tempSession()
		const ts = new Date(Date.now() - 1000).toISOString()
		await appendHistory(parentId, [
			{ role: 'user', content: 'parent msg', ts } as Message,
			{ role: 'assistant', text: 'parent reply', ts } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		await appendHistory(childId, [
			{ role: 'user', content: 'child msg', ts: new Date().toISOString() } as Message,
			{ role: 'assistant', text: 'child reply', ts: new Date().toISOString() } as Message,
		])

		// Simulate what runtime compact does
		const msgs = await readHistory(childId)
		const context = buildCompactionContext(childId, msgs)
		await rotateLog(childId)
		const forkEntry = (msgs[0] as any)?.type === 'forked_from' ? [msgs[0]] : []
		await appendHistory(childId, [
			...forkEntry,
			{ role: 'user', content: '[system] compacted', ts: new Date().toISOString() } as Message,
			{ role: 'user', content: context, ts: new Date().toISOString() } as Message,
		])

		// After compaction, forked_from should still be the first entry
		const newMsgs = await readHistory(childId)
		expect((newMsgs[0] as any).type).toBe('forked_from')
		expect((newMsgs[0] as any).parent).toBe(parentId)

		// And loadAllHistory should still resolve parent history
		const allMsgs = await loadAllHistory(childId)
		const texts = allMsgs.map((m: any) => m.content ?? m.text ?? '').filter(Boolean)
		expect(texts.some(t => t.includes('parent msg'))).toBe(true)
	})

	test('compaction of non-fork session has no forked_from', async () => {
		const id = tempSession()
		await appendHistory(id, [
			{ role: 'user', content: 'hello', ts: new Date().toISOString() } as Message,
			{ role: 'assistant', text: 'hi', ts: new Date().toISOString() } as Message,
		])

		const msgs = await readHistory(id)
		await rotateLog(id)
		const forkEntry = (msgs[0] as any)?.type === 'forked_from' ? [msgs[0]] : []
		await appendHistory(id, [
			...forkEntry,
			{ role: 'user', content: '[system] compacted', ts: new Date().toISOString() } as Message,
		])

		const newMsgs = await readHistory(id)
		expect((newMsgs[0] as any).role).toBe('user')
		expect((newMsgs[0] as any).content).toBe('[system] compacted')
	})
})