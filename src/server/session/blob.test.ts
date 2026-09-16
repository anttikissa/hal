import { expect, test, afterEach } from 'bun:test'
import { blob } from './blob.ts'
import { sessions } from '../sessions.ts'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const originalLoadHistory = sessions.loadHistory
const originalSessionDir = sessions.sessionDir
let testDir = ''

afterEach(() => {
	sessions.loadHistory = originalLoadHistory
	blob.state.forkParents.clear()
	sessions.sessionDir = originalSessionDir
	if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
	testDir = ''
})

test('resolving missing blobs reads fork history once per session', () => {
	let loads = 0
	sessions.loadHistory = ((sessionId: string) => {
		loads++
		// A forked session points at its parent in the first history entry.
		if (sessionId === 'child') return [{ type: 'forked_from', parent: 'parent' }] as any
		return [] as any
	}) as typeof sessions.loadHistory

	for (let i = 0; i < 20; i++) blob.readBlobFromChain('child', `missing-${i}`)

	// Without caching this walks the whole history file per blob: 20 child + 20 parent.
	expect(loads).toBe(2)
})


test('persists raw provider output beside the owning session', async () => {
	testDir = mkdtempSync(`${tmpdir()}/hal-raw-provider-output-`)
	sessions.sessionDir = (sessionId) => `${testDir}/${sessionId}`

	await blob.writeRawProviderOutput('session_1', 'anthropic', 'data: {not json}\n')

	const dir = `${testDir}/session_1/provider-streams`
	const files = readdirSync(dir)
	expect(files).toHaveLength(1)
	expect(files[0]).toEndWith('-anthropic.sse')
	expect(readFileSync(`${dir}/${files[0]}`, 'utf-8')).toBe('data: {not json}\n')
})
