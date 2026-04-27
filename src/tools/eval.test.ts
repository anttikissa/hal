import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../state.ts'
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
