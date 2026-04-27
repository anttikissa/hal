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

test('eval renders returned objects as ASON instead of JSON', async () => {
	const out = await evalTool.execute({
		code: "return { tabs: 40, sessionId: '03-fky' }",
	}, { sessionId: testSessionId, cwd: process.cwd() })

	expect(out).toBe("{ tabs: 40, sessionId: '03-fky' }")
	expect(out).not.toContain('"tabs"')
})

test('eval ctx.info emits a visible session info event', async () => {
	const events: any[] = []
	const origAppendEvent = ipc.appendEvent
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}
	try {
		const out = await evalTool.execute({
			code: "ctx.info('hello from eval')\nreturn 'done'",
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
