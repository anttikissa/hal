import { describe, test, expect, beforeEach } from 'bun:test'
import {
	createCommandScheduler,
	enqueueCommand,
	pauseSession,
	resumeSession,
	isSessionPaused,
	sessionQueueLength,
	sessionQueuedCommands,
	drainQueuedCommands,
	pausedSessionIds,
	totalQueuedCommands,
} from './command-scheduler.ts'
import { makeCommand, type RuntimeCommand } from '../protocol.ts'

const source = { kind: 'cli' as const, clientId: 'test' }
function cmd(text: string): RuntimeCommand {
	return makeCommand('prompt', source, text)
}

describe('command-scheduler pause/resume', () => {
	let ran: string[]

	beforeEach(() => {
		ran = []
		createCommandScheduler(
			4,
			async (_sessionId, command) => {
				ran.push(command.text ?? '')
				// Simulate async work
				await new Promise((r) => setTimeout(r, 5))
			},
		)
	})

	test('paused session does not drain', async () => {
		pauseSession('s1')
		enqueueCommand('s1', cmd('hello'))
		// Give scheduler a tick to drain
		await new Promise((r) => setTimeout(r, 20))
		expect(ran).toEqual([])
		expect(sessionQueueLength('s1')).toBe(1)
	})

	test('resume unblocks queued commands', async () => {
		pauseSession('s1')
		enqueueCommand('s1', cmd('hello'))
		await new Promise((r) => setTimeout(r, 20))
		expect(ran).toEqual([])

		resumeSession('s1')
		await new Promise((r) => setTimeout(r, 50))
		expect(ran).toEqual(['hello'])
	})

	test('multiple queued commands run in order after resume', async () => {
		pauseSession('s1')
		enqueueCommand('s1', cmd('a'))
		enqueueCommand('s1', cmd('b'))
		enqueueCommand('s1', cmd('c'))
		expect(sessionQueueLength('s1')).toBe(3)

		resumeSession('s1')
		await new Promise((r) => setTimeout(r, 100))
		expect(ran).toEqual(['a', 'b', 'c'])
	})

	test('isSessionPaused and pausedSessionIds', () => {
		expect(isSessionPaused('s1')).toBe(false)
		pauseSession('s1')
		expect(isSessionPaused('s1')).toBe(true)
		expect(pausedSessionIds()).toEqual(['s1'])
		resumeSession('s1')
		expect(isSessionPaused('s1')).toBe(false)
		expect(pausedSessionIds()).toEqual([])
	})

	test('sessionQueuedCommands returns queue contents without draining', () => {
		enqueueCommand('s1', cmd('x'))
		// First command is already dequeued and running, so queue it while paused
		pauseSession('s1')
		enqueueCommand('s1', cmd('y'))
		enqueueCommand('s1', cmd('z'))
		const queued = sessionQueuedCommands('s1')
		expect(queued.length).toBe(2)
		expect(queued[0].text).toBe('y')
		expect(queued[1].text).toBe('z')
		// Still in queue
		expect(sessionQueueLength('s1')).toBe(2)
	})

	test('drainQueuedCommands clears queue', () => {
		pauseSession('s1')
		enqueueCommand('s1', cmd('a'))
		enqueueCommand('s1', cmd('b'))
		const dropped = drainQueuedCommands('s1')
		expect(dropped.length).toBe(2)
		expect(sessionQueueLength('s1')).toBe(0)
	})

	test('pause does not affect other sessions', async () => {
		pauseSession('s1')
		enqueueCommand('s1', cmd('blocked'))
		enqueueCommand('s2', cmd('free'))
		await new Promise((r) => setTimeout(r, 50))
		expect(ran).toEqual(['free'])
		expect(sessionQueueLength('s1')).toBe(1)
	})
})
