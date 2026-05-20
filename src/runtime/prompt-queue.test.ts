import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { promptQueue } from './prompt-queue.ts'

const sessionId = `test-queue-${Date.now().toString(36)}`

afterEach(() => {
	rmSync(`${promptQueue.config.sessionsDir}/${sessionId}`, { recursive: true, force: true })
})

test('append, load, clear', () => {
	const count = promptQueue.append(sessionId, { text: 'do next', source: 'user', createdAt: '2026-05-20T00:00:00.000Z' })

	expect(count).toBe(1)
	expect(promptQueue.load(sessionId)).toEqual([{ text: 'do next', source: 'user', createdAt: '2026-05-20T00:00:00.000Z' }])

	promptQueue.clear(sessionId)
	expect(promptQueue.load(sessionId)).toEqual([])
})

test('drain returns entries in order and clears', () => {
	promptQueue.append(sessionId, { text: 'first', createdAt: '2026-05-20T00:00:00.000Z' })
	promptQueue.append(sessionId, { text: 'second', createdAt: '2026-05-20T00:00:01.000Z' })

	expect(promptQueue.drain(sessionId).map((entry) => entry.text)).toEqual(['first', 'second'])
	expect(promptQueue.load(sessionId)).toEqual([])
})
