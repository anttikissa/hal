import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../state.ts'
import { ipc } from '../ipc.ts'
import { evalTool } from './eval.ts'

const testSessionId = 'eval-test-session'

afterEach(() => {
	rmSync(join(STATE_DIR, 'sessions', testSessionId), { recursive: true, force: true })
})

test('eval renders returned objects as readable multiline ASON instead of JSON', async () => {
	const out = await evalTool.execute({
		code: "return [{ number: 7, sessionId: '04-cxx', name: 'review prompt.ts plan round2', title: null, doneUnseen: true, greenCheckmark: true, cwd: '/Users/antti/.hal' }]",
	}, { sessionId: testSessionId, cwd: process.cwd() })

	expect(out).toContain('\n')
	expect(out).toContain("  {")
	expect(out).toContain("    sessionId: '04-cxx'")
	expect(out).not.toContain('"tabs"')
})

test('eval returns no tool output when code does not return a value', async () => {
	const out = await evalTool.execute({
		code: 'let x = 1',
	}, { sessionId: testSessionId, cwd: process.cwd() })

	expect(out).toBe('')
})

test('eval can call public runtime.emitInfo for visible session messages', async () => {
	const events: any[] = []
	const origAppendEvent = ipc.appendEvent
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}
	try {
		const out = await evalTool.execute({
			code: `import { runtime } from '${process.cwd()}/src/server/runtime.ts'\nruntime.emitInfo(ctx.sessionId, 'hello from eval')\nreturn 'done'`,
		}, { sessionId: testSessionId, cwd: process.cwd() })

		expect(out).toBe('done')
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: 'info',
			text: 'hello from eval',
			level: 'info',
			sessionId: testSessionId,
		})
		expect(typeof events[0]?.id).toBe('string')
		expect(typeof events[0]?.createdAt).toBe('string')
	} finally {
		ipc.appendEvent = origAppendEvent
	}
})
