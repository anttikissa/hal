import { test, expect, afterEach } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { appendHistory, loadHydrationData } from './history.ts'

const STATE_DIR = process.env.HAL_STATE_DIR || `${process.env.HAL_DIR || process.env.HOME + '/.hal'}/state`
const testSessionIds: string[] = []

function testSessionId(prefix: string): string {
	const id = `__test_${prefix}_${randomBytes(4).toString('hex')}`
	testSessionIds.push(id)
	return id
}

afterEach(() => {
	for (const id of testSessionIds.splice(0)) {
		const dir = `${STATE_DIR}/sessions/${id}`
		if (existsSync(dir)) rmSync(dir, { recursive: true })
	}
})

test('loadHydrationData reuses local history for input history while replay includes fork chain', async () => {
	const parentId = testSessionId('hydr_parent')
	const childId = testSessionId('hydr_child')
	const parentTs = '2026-01-01T00:00:00.000Z'
	const forkTs = '2026-01-01T00:00:01.000Z'
	const childTs = '2026-01-01T00:00:02.000Z'

	await appendHistory(parentId, [{ role: 'user', content: 'prompt from parent', ts: parentTs }])
	await appendHistory(childId, [
		{ type: 'forked_from', parent: parentId, ts: forkTs },
		{ role: 'user', content: 'prompt from child', ts: childTs },
	])

	const hydrated = await loadHydrationData(childId)
	const replayUserTexts = hydrated.replayMessages
		.filter((entry: any) => entry.role === 'user' && typeof entry.content === 'string')
		.map((entry: any) => entry.content)

	expect(replayUserTexts).toContain('prompt from parent')
	expect(replayUserTexts).toContain('prompt from child')
	expect(hydrated.inputHistory).toEqual(['prompt from child'])
})
