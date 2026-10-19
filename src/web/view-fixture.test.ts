// Shared fixtures for the web view tests: a session, the folding of
// events into view state and a running turn, and titles.names reset
// around each test.

import { afterEach, beforeEach } from 'bun:test'
import { titles } from '../common/titles.ts'
import type { Event } from '../common/protocol.ts'
import { view, type ViewState } from './view.ts'

export const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
export const sessionId = meta.id
export const ts = '2026-09-26T00:00:01Z'

// Model names learned in one test stay out of the next.
export function useNames(): void {
	let originalNames: Record<string, string>
	beforeEach(() => {
		originalNames = titles.names
		titles.names = {}
	})
	afterEach(() => {
		titles.names = originalNames
	})
}

export const fold = (events: Event[], st: ViewState = {}) => events.reduce(view.onEvent, st)

export const running = (items: Event[], state: object) =>
	fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } },
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake' },
		...items,
		{ type: 'state', sessionId, state } as Event,
	] as Event[])
