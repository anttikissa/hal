import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ipc } from '../ipc.ts'
import { ason } from '../utils/ason.ts'
import { spawnAgent } from './spawn_agent.ts'

const origAppendCommand = ipc.appendCommand
const origStateDir = process.env.HAL_STATE_DIR
let tempStateDir: string | null = null

function useTempStateDir(): string {
	tempStateDir = mkdtempSync(join(tmpdir(), 'hal-spawn-agent-'))
	process.env.HAL_STATE_DIR = tempStateDir
	return tempStateDir
}

afterEach(() => {
	ipc.appendCommand = origAppendCommand
	if (origStateDir === undefined) delete process.env.HAL_STATE_DIR
	else process.env.HAL_STATE_DIR = origStateDir
	if (tempStateDir) rmSync(tempStateDir, { recursive: true, force: true })
	tempStateDir = null
})

test('spawn_agent reserves a child session ID and queues it in the spawn command', async () => {
	const stateDir = useTempStateDir()
	const appended: any[] = []
	ipc.appendCommand = (command) => {
		appended.push(command)
	}

	const result = await spawnAgent.execute({ task: 'Investigate foo' }, { sessionId: '04-parent', cwd: '/tmp/project' })
	const queued = appended[0]
	const parsed = ason.parse(String(queued.text)) as Record<string, unknown>
	const childSessionId = String(parsed.sessionId ?? '')

	expect(result).toContain('04-parent')
	expect(result).toContain(childSessionId)
	expect(appended).toHaveLength(1)
	expect(queued).toMatchObject({
		type: 'spawn',
		sessionId: '04-parent',
	})
	expect(parsed).toMatchObject({
		task: 'Investigate foo',
		mode: 'fork',
		cwd: '/tmp/project',
		closeWhenDone: false,
	})
	expect(childSessionId).toMatch(/^\d{2}-[a-z0-9]{3}$/)
	expect(existsSync(`${stateDir}/sessions/${childSessionId}`)).toBe(true)
})

test('spawn_agent passes through fresh mode and closeWhenDone', async () => {
	useTempStateDir()
	const appended: any[] = []
	ipc.appendCommand = (command) => {
		appended.push(command)
	}

	const result = await spawnAgent.execute(
		{ task: 'Research bar', mode: 'fresh', model: 'openai/gpt-5', cwd: '/work', title: 'Bar scout', closeWhenDone: true },
		{ sessionId: '04-parent', cwd: '/tmp/project' },
	)
	const parsed = ason.parse(String(appended[0]?.text)) as Record<string, unknown>
	const childSessionId = String(parsed.sessionId ?? '')

	expect(result).toContain(childSessionId)
	expect(appended[0]).toMatchObject({
		type: 'spawn',
		sessionId: '04-parent',
	})
	expect(parsed).toMatchObject({
		task: 'Research bar',
		mode: 'fresh',
		model: 'openai/gpt-5',
		cwd: '/work',
		title: 'Bar scout',
		closeWhenDone: true,
	})
})
