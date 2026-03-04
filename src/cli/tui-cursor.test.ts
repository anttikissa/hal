import { describe, test, expect, beforeEach } from 'bun:test'
import {
	setActiveTabCursor, setHalState, getTabTier, restoreHalIdleTimer,
	_testCursor,
} from './tui'

beforeEach(() => { _testCursor.resetAll() })

describe('dormant cursor survives background tab activity', () => {
	test('setHalState for background tab does not reset shrink', () => {
		// Tab 2 is active and idle
		setActiveTabCursor('tab2')
		setHalState('idle', 'tab2')

		// Simulate tab2 being dormant: set shrinkStart in the past
		const hal = _testCursor.hal
		hal.shrinkStart = Date.now() - 1000
		hal.brightSince = null
		expect(_testCursor.isDormant()).toBe(true)

		// Background tab1 goes busy (status event from runtime)
		setHalState('writing', 'tab1')

		// Tab 2's dormant animation must be preserved
		expect(hal.shrinkStart).not.toBeNull()
		expect(_testCursor.isDormant()).toBe(true)
	})

	test('setHalState for active tab DOES reset shrink on state change', () => {
		setActiveTabCursor('tab1')
		setHalState('idle', 'tab1')

		const hal = _testCursor.hal
		hal.shrinkStart = Date.now() - 1000
		expect(_testCursor.isDormant()).toBe(true)

		// Active tab goes busy
		setHalState('writing', 'tab1')
		expect(hal.shrinkStart).toBeNull()
		expect(_testCursor.isDormant()).toBe(false)
	})

	test('idle→idle on active tab does NOT reset shrink (no-op)', () => {
		setActiveTabCursor('tab2')
		setHalState('idle', 'tab2')

		const hal = _testCursor.hal
		hal.shrinkStart = Date.now() - 1000
		expect(_testCursor.isDormant()).toBe(true)

		// Re-apply idle to active tab (status loop for active tab that was already idle)
		setHalState('idle', 'tab2')

		// Still dormant
		expect(hal.shrinkStart).not.toBeNull()
		expect(_testCursor.isDormant()).toBe(true)
	})

	test('restoreHalIdleTimer preserves dormant when already past delay', () => {
		setActiveTabCursor('tab2')
		const pastTs = Date.now() - 60_000 // 60s ago, well past any delay

		restoreHalIdleTimer(pastTs)

		const hal = _testCursor.hal
		expect(hal.shrinkStart).not.toBeNull()
	})

	test('full status loop: dormant active tab survives background busy tab', () => {
		// Setup: tab1 busy, tab2 active and dormant
		setActiveTabCursor('tab2')
		setHalState('idle', 'tab1')
		setHalState('idle', 'tab2')

		const hal = _testCursor.hal
		hal.shrinkStart = Date.now() - 1000
		expect(_testCursor.isDormant()).toBe(true)

		// Simulate the full status loop from client.ts:
		// for each tab: setHalState(deriveHalState(tab), tab.sessionId)
		const tabs = [
			{ sessionId: 'tab1', state: 'writing' as const },
			{ sessionId: 'tab2', state: 'idle' as const },
		]
		for (const tab of tabs) {
			setHalState(tab.state, tab.sessionId)
		}

		// Active tab2 should still be dormant
		expect(hal.shrinkStart).not.toBeNull()
		expect(_testCursor.isDormant()).toBe(true)
		expect(getTabTier('tab2')).toBe('dormant')
		expect(getTabTier('tab1')).toBe('busy')
	})
})
