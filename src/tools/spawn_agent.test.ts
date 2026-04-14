import { afterEach, expect, test } from 'bun:test'
import { ipc } from '../ipc.ts'
import { spawnAgent } from './spawn_agent.ts'

const origAppendCommand = ipc.appendCommand

afterEach(() => {
	ipc.appendCommand = origAppendCommand
})

test('spawn_agent queues a spawn command with defaults', async () => {
	const appended: any[] = []
	ipc.appendCommand = (command) => {
		appended.push(command)
	}

	const result = await spawnAgent.execute({ task: 'Investigate foo' }, { sessionId: '04-parent', cwd: '/tmp/project' })

	expect(result).toContain('04-parent')
	expect(appended).toHaveLength(1)
	expect(appended[0]).toMatchObject({
		type: 'spawn',
		sessionId: '04-parent',
		text: JSON.stringify({
			task: 'Investigate foo',
			mode: 'fork',
			cwd: '/tmp/project',
			closeWhenDone: false,
		}),
	})
})

test('spawn_agent passes through fresh mode and closeWhenDone', async () => {
	const appended: any[] = []
	ipc.appendCommand = (command) => {
		appended.push(command)
	}

	await spawnAgent.execute(
		{ task: 'Research bar', mode: 'fresh', model: 'openai/gpt-5', cwd: '/work', title: 'Bar scout', closeWhenDone: true },
		{ sessionId: '04-parent', cwd: '/tmp/project' },
	)

	expect(appended[0]).toMatchObject({
		type: 'spawn',
		sessionId: '04-parent',
		text: JSON.stringify({
			task: 'Research bar',
			mode: 'fresh',
			model: 'openai/gpt-5',
			cwd: '/work',
			title: 'Bar scout',
			closeWhenDone: true,
		}),
	})
})
