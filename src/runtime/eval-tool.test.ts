import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { executeEval, type EvalContext } from './eval-tool.ts'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

const TEST_DIR = '/tmp/hal-eval-test-' + Date.now()

function makeCtx(sessionId = 'test-session'): EvalContext {
	return {
		sessionId,
		halDir: TEST_DIR,
		stateDir: join(TEST_DIR, 'state'),
		cwd: process.cwd(),
	}
}

beforeAll(() => {
	mkdirSync(join(TEST_DIR, 'state', 'sessions', 'test-session'), { recursive: true })
})

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('eval-tool', () => {
	test('returns last expression value', async () => {
		const result = await executeEval('return 1 + 2', makeCtx())
		expect(result).toBe('3')
	})

	test('returns stringified objects', async () => {
		const result = await executeEval('return { a: 1, b: "hello" }', makeCtx())
		expect(JSON.parse(result)).toEqual({ a: 1, b: "hello" })
	})

	test('has access to ctx', async () => {
		const result = await executeEval('return ctx.sessionId', makeCtx())
		expect(result).toBe('test-session')
	})

	test('can import modules', async () => {
		const result = await executeEval(`
			const { join } = await import('path')
			return join('a', 'b')
		`, makeCtx())
		expect(result).toBe('a/b')
	})

	test('returns error on throw', async () => {
		const result = await executeEval('throw new Error("boom")', makeCtx())
		expect(result).toContain('Error: boom')
	})

	test('returns undefined for void code', async () => {
		const result = await executeEval('const x = 1', makeCtx())
		expect(result).toBe('undefined')
	})

	test('persists eval file', async () => {
		await executeEval('return 42', makeCtx())
		const evalDir = join(TEST_DIR, 'state', 'sessions', 'test-session', 'eval')
		expect(existsSync(evalDir)).toBe(true)
		const files = require('fs').readdirSync(evalDir)
		expect(files.length).toBeGreaterThan(0)
		expect(files.some((f: string) => f.endsWith('.ts'))).toBe(true)
	})
})
