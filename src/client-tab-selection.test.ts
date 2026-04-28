import { describe, expect, test } from 'bun:test'
import { pickActiveSessionAfterSessionListChange } from './client.ts'

describe('pickActiveSessionAfterSessionListChange', () => {
	test('closing the active middle tab switches to the right neighbor', () => {
		const picked = pickActiveSessionAfterSessionListChange({
			previousSession: 'closed',
			previousIndex: 1,
			previousLength: 3,
			newSessionIds: ['left', 'right'],
			recentTabs: ['left', 'closed'],
			pendingOpen: false,
			openedSessionId: '',
		})

		expect(picked).toBe('right')
	})

	test('closing a client-created child tab returns to its opener', () => {
		const picked = pickActiveSessionAfterSessionListChange({
			previousSession: 'child',
			previousIndex: 1,
			previousLength: 3,
			newSessionIds: ['parent', 'right'],
			recentTabs: ['parent', 'child'],
			pendingOpen: false,
			openedSessionId: '',
			returnToSession: 'parent',
		})

		expect(picked).toBe('parent')
	})

	test('closing the active last tab falls back left even with remembered focus', () => {
		const picked = pickActiveSessionAfterSessionListChange({
			previousSession: 's3',
			previousIndex: 2,
			previousLength: 3,
			newSessionIds: ['s1', 's2'],
			recentTabs: ['s2', 's1', 's3'],
			pendingOpen: false,
			openedSessionId: '',
		})

		expect(picked).toBe('s2')
	})

	test('closing the active last tab falls back to the new last tab without memory', () => {
		const picked = pickActiveSessionAfterSessionListChange({
			previousSession: 's3',
			previousIndex: 2,
			previousLength: 3,
			newSessionIds: ['s1', 's2'],
			recentTabs: ['s3'],
			pendingOpen: false,
			openedSessionId: '',
		})

		expect(picked).toBe('s2')
	})
})
