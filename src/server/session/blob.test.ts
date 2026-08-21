import { expect, test, afterEach } from 'bun:test'
import { blob } from './blob.ts'
import { sessions } from '../sessions.ts'

const originalLoadHistory = sessions.loadHistory

afterEach(() => {
	sessions.loadHistory = originalLoadHistory
	blob.state.forkParents.clear()
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
