import { expect, test, beforeEach } from 'bun:test'
import type { SharedState } from '../../common/ipc.ts'
import type { ClientSessionSnapshot } from '../../common/snapshots.ts'
import { sessionSelection } from './session-selection.ts'

function snapshotOf(id: string): ClientSessionSnapshot {
	return { session: { id, cwd: '/' }, meta: { id, createdAt: '' }, history: [], parentCount: 0, live: [] }
}

function stateOf(...ids: string[]): SharedState {
	return { sessions: ids.map((id) => ({ id, cwd: '/' })), working: {}, updatedAt: '' }
}

beforeEach(() => sessionSelection.consumeOpenRequest())

test('restores the remembered tab when the app reopens at the root', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b'), '', new Set(), false, 'b')).toBe('b')
})

test('ignores a remembered tab that is no longer open', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b'), '', new Set(), false, 'closed')).toBe('a')
})

test('an open request survives broadcasts that bring no new session yet', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b'), 'b', new Set(['a', 'b']), true)).toBe('b')
})

test('sessions opened by other clients do not steal the selection', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b', 'new'), 'a', new Set(['a', 'b']), false)).toBe('a')
})

test('an open request expires so a failed open cannot hijack a later tab', () => {
	sessionSelection.markOpenRequest()
	sessionSelection.state.requestedAt -= sessionSelection.config.openRequestTtlMs + 1
	expect(sessionSelection.isOpenRequestPending()).toBe(false)
})
