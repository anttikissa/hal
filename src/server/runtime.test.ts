import { expect, test } from 'bun:test'
import { runtime } from './runtime.ts'
import { ipc } from '../ipc.ts'
import { agentLoop } from '../runtime/agent-loop.ts'

test('pickMostRecentlyClosedSessionId prefers the newest closed session', () => {
	const picked = runtime.pickMostRecentlyClosedSessionId(
		[
			{ id: '04-open', createdAt: '2026-04-13T18:00:00.000Z' },
			{ id: '04-old', createdAt: '2026-04-13T18:01:00.000Z', closedAt: '2026-04-13T18:05:00.000Z' },
			{ id: '04-new', createdAt: '2026-04-13T18:02:00.000Z', closedAt: '2026-04-13T18:06:00.000Z' },
		],
		new Set(['04-open']),
	)

	expect(picked).toBe('04-new')
})

test('pickMostRecentlyClosedSessionId falls back to createdAt when closedAt is missing', () => {
	const picked = runtime.pickMostRecentlyClosedSessionId(
		[
			{ id: '04-a', createdAt: '2026-04-13T18:01:00.000Z' },
			{ id: '04-b', createdAt: '2026-04-13T18:02:00.000Z' },
		],
		new Set(),
	)

	expect(picked).toBe('04-b')
})

test('pickMostRecentlyClosedSessionId returns null when nothing is closed', () => {
	const picked = runtime.pickMostRecentlyClosedSessionId(
		[{ id: '04-open', createdAt: '2026-04-13T18:00:00.000Z' }],
		new Set(['04-open']),
	)

	expect(picked).toBeNull()
})

test('shouldAutoContinue allows restart notices but not manual pauses', () => {
	const recent = '2026-04-14T12:00:00.000Z'
	expect(runtime.shouldAutoContinue([
		{ type: 'user', ts: recent },
		{ type: 'info', text: '[restarted]', ts: '2026-04-14T12:00:01.000Z' },
	], Date.parse('2026-04-14T12:00:05.000Z'))).toBe(true)
	expect(runtime.shouldAutoContinue([
		{ type: 'user', ts: recent },
		{ type: 'info', text: '[paused]', ts: '2026-04-14T12:00:01.000Z' },
	], Date.parse('2026-04-14T12:00:05.000Z'))).toBe(false)
})


test('recordTabClosed emits info when no generation is active', () => {
	const events: any[] = []
	const origAbort = agentLoop.abort
	const origAppendEvent = ipc.appendEvent
	agentLoop.abort = () => false
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		runtime.recordTabClosed('04-idle')
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: 'info',
			sessionId: '04-idle',
			text: 'Tab closed',
			level: 'info',
		})
	} finally {
		agentLoop.abort = origAbort
		ipc.appendEvent = origAppendEvent
	}
})


test('resolveResumeTarget matches a closed session by name case-insensitively', () => {
	const picked = runtime.resolveResumeTarget(
		[
			{ id: '04-a', createdAt: '2026-04-13T18:01:00.000Z', name: 'Pause Fix' },
			{ id: '04-b', createdAt: '2026-04-13T18:02:00.000Z', name: 'Other' },
		],
		new Set(),
		'pause fix',
	)

	expect(picked).toBe('04-a')
})
