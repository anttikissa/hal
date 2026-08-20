import { expect, test } from 'bun:test'
import { wait } from './wait.ts'
import { agentLoop } from '../runtime/agent-loop.ts'

test('wait identifies active subagents by tab and name', async () => {
	const original = (agentLoop as any).runningSubagents
	let parentId = ''
	;(agentLoop as any).runningSubagents = (sessionId: string) => {
		parentId = sessionId
		return [
			{ id: '123-xyz', tab: 11, name: 'Review rendering regression' },
			{ id: '234-yyz', tab: 12 },
		]
	}

	try {
		expect(await wait.execute({}, { sessionId: 'parent', cwd: '/tmp' })).toBe('Waiting for the next subagent. Active: 123-xyz (Review rendering regression, tab 11), 234-yyz (tab 12)')
		expect(parentId).toBe('parent')
	} finally {
		;(agentLoop as any).runningSubagents = original
	}
})


test('wait warns when no subagents are active', async () => {
	const original = (agentLoop as any).runningSubagents
	;(agentLoop as any).runningSubagents = () => []

	try {
		expect(await wait.execute({}, { sessionId: 'parent', cwd: '/tmp' })).toBe('No active subagents. Waiting for a message; send a prompt or spawn a subagent to resume.')
	} finally {
		;(agentLoop as any).runningSubagents = original
	}
})
