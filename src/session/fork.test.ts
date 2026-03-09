import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { sessionDir, ensureDir } from '../state.ts'
import { appendMessages, readMessages, loadApiMessages, type Message } from './messages.ts'
import { forkSession } from './session.ts'
import { stringify, parseAll } from '../utils/ason.ts'

const createdIds: string[] = []

function tempSession(): string {
	const id = `t-${randomBytes(4).toString('hex')}`
	createdIds.push(id)
	const dir = sessionDir(id)
	ensureDir(dir)
	writeFileSync(join(dir, 'meta.ason'), stringify({ id, workingDir: '/tmp', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: 'messages.asonl' }) + '\n')
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
		await appendMessages(parentId, [
			{ role: 'user', content: 'hello', ts } as Message,
			{ role: 'assistant', content: 'hi there', ts } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		// Child session dir exists
		expect(existsSync(sessionDir(childId))).toBe(true)

		// Child has forked_from as first entry
		const raw = readFileSync(join(sessionDir(childId), 'messages.asonl'), 'utf-8')
		const entries = parseAll(raw)
		expect(entries[0]).toMatchObject({ type: 'forked_from', parent: parentId })
	})

	test('child has meta.ason with log field', async () => {
		const parentId = tempSession()
		await appendMessages(parentId, [
			{ role: 'user', content: 'hello', ts: new Date().toISOString() } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		const metaRaw = readFileSync(join(sessionDir(childId), 'meta.ason'), 'utf-8')
		const meta = parseAll(metaRaw)[0] as any
		expect(meta.log).toBe('messages.asonl')
		expect(meta.id).toBe(childId)
	})

	test('loadApiMessages on child includes parent history', async () => {
		const parentId = tempSession()
		const ts = new Date().toISOString()
		await appendMessages(parentId, [
			{ role: 'user', content: 'parent message', ts } as Message,
			{ role: 'assistant', text: 'parent reply', ts } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		// Add a message in the child
		await appendMessages(childId, [
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
		await appendMessages(parentId, [
			{ role: 'user', content: 'shared', ts: ts1 } as Message,
			{ role: 'assistant', text: 'shared reply', ts: ts1 } as Message,
		])

		const childId = await forkSession(parentId)
		createdIds.push(childId)

		// Add different messages to parent and child — with later timestamps
		const ts2 = new Date().toISOString()
		await appendMessages(parentId, [
			{ role: 'user', content: 'parent only', ts: ts2 } as Message,
		])
		await appendMessages(childId, [
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
})
