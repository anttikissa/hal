import { describe, expect, test } from 'bun:test'
import { pickActiveSessionAfterSessionListChange } from './client.ts'

describe('pickActiveSessionAfterSessionListChange', () => {
	test('closing the active middle tab keeps focus at the same slot', () => {
		const picked = pickActiveSessionAfterSessionListChange({
			previousSession: 's24',
			previousIndex: 23,
			previousLength: 25,
			newSessionIds: Array.from({ length: 24 }, (_, i) => `s${i + 1 === 24 ? 25 : i + 1}`),
			recentTabs: ['s23', 's24'],
			pendingOpen: false,
			openedSessionId: '',
		})

		expect(picked).toBe('s25')
	})

	test('closing the active last tab falls back to the new last tab', () => {
		const picked = pickActiveSessionAfterSessionListChange({
			previousSession: 's3',
			previousIndex: 2,
			previousLength: 3,
			newSessionIds: ['s1', 's2'],
			recentTabs: ['s1', 's3'],
			pendingOpen: false,
			openedSessionId: '',
		})

		expect(picked).toBe('s2')
	})
})
