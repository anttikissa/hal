import { test, expect, beforeEach } from 'bun:test'
import { queue } from './queue.ts'
import { state } from '../state.ts'
import { existsSync } from 'fs'

const SESSION = 'test-queue-' + Date.now().toString(36)

beforeEach(() => {
	state.ensureDir(state.sessionDir(SESSION))
})

test('saveQueue + loadQueue round-trip', async () => {
	await queue.saveQueue(SESSION, 'do something next')
	expect(await queue.loadQueue(SESSION)).toBe('do something next')
})

test('saveQueue empty clears queue', async () => {
	await queue.saveQueue(SESSION, 'something')
	await queue.saveQueue(SESSION, '')
	expect(await queue.loadQueue(SESSION)).toBe('')
})

test('loadQueue returns empty for non-existent', async () => {
	expect(await queue.loadQueue('nonexistent-queue-test')).toBe('')
})

test('saveQueue overwrites previous', async () => {
	await queue.saveQueue(SESSION, 'first')
	await queue.saveQueue(SESSION, 'second')
	expect(await queue.loadQueue(SESSION)).toBe('second')
})
