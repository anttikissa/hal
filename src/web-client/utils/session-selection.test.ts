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

test('keeps the current selection when it still exists', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b'), 'b', new Set(['a']), false)).toBe('b')
})

test('falls back to the first session when the selection was closed elsewhere', () => {
	expect(sessionSelection.nextSelection(stateOf('b', 'c'), 'a', new Set(['a', 'b']), false)).toBe('b')
})

test('restores the remembered tab when the app reopens at the root', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b'), '', new Set(), false, 'b')).toBe('b')
})

test('ignores a remembered tab that is no longer open', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b'), '', new Set(), false, 'closed')).toBe('a')
})

test('an open command lands on the freshly created session', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b', 'c'), 'b', new Set(['a', 'b']), true)).toBe('c')
})

test('an open request survives broadcasts that bring no new session yet', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b'), 'b', new Set(['a', 'b']), true)).toBe('b')
})

test('sessions opened by other clients do not steal the selection', () => {
	expect(sessionSelection.nextSelection(stateOf('a', 'b', 'new'), 'a', new Set(['a', 'b']), false)).toBe('a')
})

test('returns empty when no sessions are open', () => {
	expect(sessionSelection.nextSelection(stateOf(), '', new Set(), false)).toBe('')
})

test('markOpenRequest makes the next broadcast grab the first unseen session once', () => {
	sessionSelection.markOpenRequest()
	expect(sessionSelection.isOpenRequestPending()).toBe(true)
	const picked = sessionSelection.nextSelection(stateOf('a', 'b'), 'a', new Set(['a']), sessionSelection.isOpenRequestPending())
	expect(picked).toBe('b')
	// Consumed after use: a later unrelated session must not steal the view.
	expect(sessionSelection.isOpenRequestPending()).toBe(false)
})

test('an open request expires so a failed open cannot hijack a later tab', () => {
	sessionSelection.markOpenRequest()
	sessionSelection.state.requestedAt -= sessionSelection.config.openRequestTtlMs + 1
	expect(sessionSelection.isOpenRequestPending()).toBe(false)
})

test('finds the bootstrap snapshot for a deep-linked session', () => {
	const selected = sessionSelection.snapshotFor('05-pay', [snapshotOf('05-pay'), snapshotOf('11-sad')])
	expect(selected?.session.id).toBe('05-pay')
})
