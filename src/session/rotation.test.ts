import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { sessionDir, ensureDir } from '../state.ts'
import { appendHistory, readHistory, loadApiMessages, type Message } from './history.ts'
import { rotateLog } from './session.ts'
import { stringify } from '../utils/ason.ts'

const createdIds: string[] = []

function tempSession(): string {
	const id = `t-${randomBytes(4).toString('hex')}`
	createdIds.push(id)
	const dir = sessionDir(id)
	ensureDir(dir)
	// Write minimal session.ason with log field
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

describe('rotateLog', () => {
	test('rotates to history2.asonl', async () => {
		const id = tempSession()
		await appendHistory(id, [{ role: 'user', content: 'hello', ts: new Date().toISOString() } as Message])

		const newLog = await rotateLog(id)
		expect(newLog).toBe('history2.asonl')

		// Old file stays intact
		expect(existsSync(join(sessionDir(id), 'history.asonl'))).toBe(true)
	})

	test('increments rotation number', async () => {
		const id = tempSession()
		await appendHistory(id, [{ role: 'user', content: 'r1', ts: new Date().toISOString() } as Message])

		expect(await rotateLog(id)).toBe('history2.asonl')

		// Write to new log
		await appendHistory(id, [{ role: 'user', content: 'r2', ts: new Date().toISOString() } as Message])
		expect(await rotateLog(id)).toBe('history3.asonl')

		await appendHistory(id, [{ role: 'user', content: 'r3', ts: new Date().toISOString() } as Message])
		expect(await rotateLog(id)).toBe('history4.asonl')
	})

	test('appendHistory writes to current log after rotation', async () => {
		const id = tempSession()
		await appendHistory(id, [{ role: 'user', content: 'before', ts: new Date().toISOString() } as Message])

		await rotateLog(id)

		await appendHistory(id, [{ role: 'user', content: 'after', ts: new Date().toISOString() } as Message])

		// Old file should have 'before'
		const oldRaw = readFileSync(join(sessionDir(id), 'history.asonl'), 'utf-8')
		expect(oldRaw).toContain('before')
		expect(oldRaw).not.toContain('after')

		// New file should have 'after'
		const newRaw = readFileSync(join(sessionDir(id), 'history2.asonl'), 'utf-8')
		expect(newRaw).toContain('after')
		expect(newRaw).not.toContain('before')
	})

	test('loadApiMessages reads from current log after rotation', async () => {
		const id = tempSession()
		const ts = new Date().toISOString()

		await appendHistory(id, [
			{ role: 'user', content: 'old prompt', ts } as Message,
		])

		await rotateLog(id)

		await appendHistory(id, [
			{ role: 'user', content: '[system] Session was reset.', ts } as Message,
			{ role: 'user', content: 'new prompt', ts } as Message,
		])

		const apiMsgs = await loadApiMessages(id)
		const texts = apiMsgs.map((m: any) => typeof m.content === 'string' ? m.content : '')

		// Should see new messages only
		expect(texts).toContain('[system] Session was reset.')
		expect(texts).toContain('new prompt')
		expect(texts).not.toContain('old prompt')
	})
})
