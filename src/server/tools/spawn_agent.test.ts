import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ipc } from '../file-ipc.ts'
import { spawnAgent } from './spawn_agent.ts'

const origAppendCommand = ipc.appendCommand
const origReadState = ipc.readState
const origStateDir = process.env.HAL_STATE_DIR
let tempStateDir: string | null = null

function useTempStateDir(): string {
	tempStateDir = mkdtempSync(join(tmpdir(), 'hal-spawn-agent-'))
	process.env.HAL_STATE_DIR = tempStateDir
	return tempStateDir
}

afterEach(() => {
	ipc.appendCommand = origAppendCommand
	ipc.readState = origReadState
	if (origStateDir === undefined) delete process.env.HAL_STATE_DIR
	else process.env.HAL_STATE_DIR = origStateDir
	if (tempStateDir) rmSync(tempStateDir, { recursive: true, force: true })
	tempStateDir = null
})

test('subagent budgets transfer recursive capacity instead of copying it', () => {
	expect(spawnAgent.allocate(undefined, undefined)).toEqual({ parentBudget: 4, childBudget: 0 })
	expect(spawnAgent.allocate(4, 2)).toEqual({ parentBudget: 1, childBudget: 2 })
	expect(spawnAgent.allocate(2, 2)).toEqual({ error: 'subagent limit 2 needs 3 slots, but only 2 remain' })
	expect(spawnAgent.allocate(1, -1)).toEqual({ error: 'limit must be a non-negative integer' })
})

test('spawn_agent reserves a child session ID and queues it in the spawn command', async () => {
	const stateDir = useTempStateDir()
	const appended: any[] = []
	ipc.appendCommand = (command) => {
		appended.push(command)
	}
	ipc.readState = () => ({
		sessions: [
			{ id: '04-left', tab: 1, cwd: '/tmp/left' },
			{ id: '04-parent', tab: 2, cwd: '/tmp/project' },
			{ id: '04-right', tab: 3, cwd: '/tmp/right' },
		],
		working: {},
		updatedAt: new Date().toISOString(),
	})

	const result = await spawnAgent.execute({ task: 'Investigate foo' }, { sessionId: '04-parent', cwd: '/tmp/project' })
	const queued = appended[0]
	const spawn = queued.spawn
	const childSessionId = String(spawn?.childSessionId ?? '')

	expect(result).toContain('04-parent')
	expect(result).toContain(childSessionId)
	expect(result).toContain('tab 3')
	expect(result).toContain(`Subagent ${childSessionId} is working asynchronously and will report back through an inbox message when finished.`)
	expect(appended).toHaveLength(1)
	expect(queued).toMatchObject({
		type: 'spawn',
		sessionId: '04-parent',
	})
	expect(spawn).toMatchObject({
		task: 'Investigate foo',
		kind: 'subagent',
		mode: 'fork',
		cwd: '/tmp/project',
	})
	expect(childSessionId).toMatch(/^\d{2}-[a-z0-9]{3}$/)
	expect(existsSync(`${stateDir}/sessions/${childSessionId}`)).toBe(true)
})

test('spawn_agent passes through fresh mode and subagent-leave-open kind', async () => {
	useTempStateDir()
	const appended: any[] = []
	ipc.appendCommand = (command) => {
		appended.push(command)
	}

	const result = await spawnAgent.execute(
		{ task: 'Research bar', kind: 'subagent-leave-open', mode: 'fresh', model: 'openai/gpt-5.4', cwd: '/work', name: 'Bar scout', limit: 2 },
		{ sessionId: '04-parent', cwd: '/tmp/project' },
	)
	const spawn = appended[0]?.spawn
	const childSessionId = String(spawn?.childSessionId ?? '')

	expect(result).toContain(childSessionId)
	expect(appended[0]).toMatchObject({
		type: 'spawn',
		sessionId: '04-parent',
	})
	expect(spawn).toMatchObject({
		task: 'Research bar',
		kind: 'subagent-leave-open',
		mode: 'fresh',
		model: 'openai/gpt-5.4',
		cwd: '/work',
		name: 'Bar scout',
		subagentLimit: 2,
	})
})


test('spawn_agent rejects an unknown model before reserving a child session', async () => {
	const stateDir = useTempStateDir()
	const appended: any[] = []
	ipc.appendCommand = (command) => {
		appended.push(command)
	}

	const result = await spawnAgent.execute(
		{ task: 'Research bar', model: 'openai/gpt-5.6-mini' },
		{ sessionId: '04-parent', cwd: '/tmp/project' },
	)

	expect(result).toContain('Unknown model: openai/gpt-5.6-mini')
	expect(result).not.toContain('/check')
	expect(appended).toHaveLength(0)
	expect(existsSync(`${stateDir}/sessions`)).toBe(false)
})

test('spawn_agent can open an interactive session without a task', async () => {
	useTempStateDir()
	const appended: any[] = []
	ipc.appendCommand = (command) => {
		appended.push(command)
	}

	const result = await spawnAgent.execute(
		{ kind: 'interactive', mode: 'fresh', name: 'Scratch' },
		{ sessionId: '04-parent', cwd: '/tmp/project' },
	)
	const spawn = appended[0]?.spawn

	expect(result).toContain('Opened interactive session')
	expect(result).toContain('blank')
	expect(spawn).toMatchObject({
		task: '',
		kind: 'interactive',
		mode: 'fresh',
		cwd: '/tmp/project',
		name: 'Scratch',
	})
})


test('spawn_agent sends an initial prompt to interactive sessions when task is provided', async () => {
	useTempStateDir()
	const appended: any[] = []
	ipc.appendCommand = (command) => {
		appended.push(command)
	}
	ipc.readState = () => ({
		sessions: [{ id: '04-parent', tab: 24, cwd: '/tmp/project' }],
		working: {},
		updatedAt: new Date().toISOString(),
	})

	const result = await spawnAgent.execute(
		{ task: 'MAKE MODEL PICKER GREAT AGAIN', kind: 'interactive', mode: 'fresh', name: 'Fix model picker' },
		{ sessionId: '04-parent', cwd: '/tmp/project' },
	)
	const spawn = appended[0]?.spawn

	expect(result).toContain('Opened interactive session')
	expect(result).toContain('tab 25')
	expect(result).toContain('sent initial prompt')
	expect(spawn).toMatchObject({
		task: 'MAKE MODEL PICKER GREAT AGAIN',
		kind: 'interactive',
		mode: 'fresh',
		name: 'Fix model picker',
	})
})
