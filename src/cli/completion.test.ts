import { describe, test, expect } from 'bun:test'
import { completeInput, type CompletionContext } from './completion.ts'

const ctx: CompletionContext = {
	tabs: [
		{ sessionId: '01-abc', info: { topic: '.hal', workingDir: '/Users/antti/.hal' } },
		{ sessionId: '02-def', info: { topic: 'work', workingDir: '/tmp/work' } },
	],
	activeTabIndex: 0,
}

describe('completeInput', () => {
	test('completes unique command', () => {
		const r = completeInput('/mo', 3, ctx)
		expect(r).toBeTruthy()
		expect(r?.text).toBe('/model ')
		expect(r?.cursor).toBe('/model '.length)
		expect(r?.options).toEqual(['/model'])
	})

	test('returns multiple command options', () => {
		const r = completeInput('/r', 2, ctx)
		expect(r).toBeTruthy()
		expect(r?.options).toEqual(['/reset', '/respond', '/resume'])
	})

	test('completes model argument', () => {
		const r = completeInput('/model codex-s', '/model codex-s'.length, ctx)
		expect(r).toBeTruthy()
		expect(r?.text).toBe('/model codex-spark ')
	})

	test('completes session id argument for /open', () => {
		const r = completeInput('/open 01', '/open 01'.length, ctx)
		expect(r).toBeTruthy()
		expect(r?.text).toBe('/open 01-abc ')
	})

	test('completes /respond command', () => {
		const r = completeInput('/resp', '/resp'.length, ctx)
		expect(r).toBeTruthy()
		expect(r?.text).toBe('/respond ')
	})

	test('returns null for non-slash text', () => {
		expect(completeInput('hello', 5, ctx)).toBeNull()
	})

	test('completes /cd with directories', () => {
		// Use a known directory that exists
		const testCtx: CompletionContext = {
			tabs: [{ sessionId: '01-abc', info: { topic: 'test', workingDir: '/tmp' } }],
			activeTabIndex: 0,
		}
		const r = completeInput('/cd ', '/cd '.length, testCtx)
		// Should return some directory entries (whatever is in /tmp)
		expect(r).toBeTruthy()
		// All options should end with /
		if (r?.options) {
			for (const opt of r.options) {
				expect(opt.endsWith('/')).toBe(true)
			}
		}
	})

	test('/cd completion does not add trailing space for dirs', () => {
		const testCtx: CompletionContext = {
			tabs: [{ sessionId: '01-abc', info: { topic: 'test', workingDir: '/' } }],
			activeTabIndex: 0,
		}
		const r = completeInput('/cd tm', '/cd tm'.length, testCtx)
		expect(r).toBeTruthy()
		// tmp/ should match, and no trailing space since it ends with /
		expect(r?.text).toBe('/cd tmp/')
		expect(r?.cursor).toBe('/cd tmp/'.length)
	})
})
