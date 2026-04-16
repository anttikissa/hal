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

import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

test('spawnSession creates a fresh child with queued prompt and auto-close marker', async () => {
	const base = mkdtempSync(join(tmpdir(), 'hal-spawn-'))
	const prevState = process.env.HAL_STATE_DIR
	const queued: any[] = []
	const origAppendCommand = ipc.appendCommand
	process.env.HAL_STATE_DIR = base
	const { sessions } = await import('./sessions.ts')

	try {
		ipc.appendCommand = (command: any) => {
			queued.push(command)
		}
		await sessions.createSession('04-parent', {
			id: '04-parent',
			workingDir: '/work/parent',
			createdAt: '2026-04-14T12:00:00.000Z',
			model: 'anthropic/claude-sonnet-4.5',
		})
		const child = await runtime.spawnSessionForTests({
			id: '04-parent',
			name: 'parent',
			cwd: '/work/parent',
			model: 'anthropic/claude-sonnet-4.5',
			createdAt: '2026-04-14T12:00:00.000Z',
		}, {
			task: 'Do the thing',
			mode: 'fresh',
			model: 'openai/gpt-5',
			cwd: '/work/child',
			title: 'Child tab',
			closeWhenDone: true,
		})

		expect(child.model).toBe('openai/gpt-5')
		expect(child.cwd).toBe('/work/child')
		const meta = sessions.loadSessionMeta(child.id)
		expect(meta?.workingDir).toBe('/work/child')
		expect(meta?.model).toBe('openai/gpt-5')
		expect(meta?.name).toBe('Child tab')
		expect(meta?.topic).toBe('Child tab')
		const history = sessions.loadHistory(child.id)
		expect(history.some((entry) => entry.type === 'info' && entry.text.includes('close itself after sending a handoff'))).toBe(true)
		expect(history.some((entry) => entry.type === 'user' && JSON.stringify(entry).includes('Do the thing'))).toBe(false)
		expect(queued).toContainEqual(expect.objectContaining({
			type: 'prompt',
			sessionId: child.id,
			source: '04-parent',
		}))
		expect(JSON.stringify(queued)).toContain('Do the thing')
	} finally {
		ipc.appendCommand = origAppendCommand
		rmSync(base, { recursive: true, force: true })
		if (prevState === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = prevState
	}
})
