import { expect, test } from 'bun:test'
import { tool } from './eval.ts'

const ctx = (signal = new AbortController().signal) => ({ cwd: process.cwd(), sessionId: 'eval-test', signal })

// Invariant (task v99): EVAL code never blocks the host's event loop.
test('busy EVAL code leaves host timers running', async () => {
	let prev = performance.now()
	let maxGap = 0
	let timer = setInterval(() => {
		maxGap = Math.max(maxGap, performance.now() - prev)
		prev = performance.now()
	}, 5)
	let out = await tool.run({ code: 'Bun.sleepSync(500); return 42' }, ctx())
	clearInterval(timer)
	expect(out).toBe('42')
	expect(maxGap).toBeLessThan(200)
})

test('tool() rejects with the error, host() runs in the host, abort kills', async () => {
	let code = `let e = await tool('NO_SUCH_TOOL').catch(e => 'caught')
return [e, await host((n) => n + typeof Bun.sleepSync, 1)]`
	expect(await tool.run({ code }, ctx())).toContain('caught')
	expect(await tool.run({ code }, ctx())).toContain('1function')
	let abort = new AbortController()
	let run = tool.run({ code: 'while (true) {}' }, ctx(abort.signal))
	setTimeout(() => abort.abort(), 100)
	await expect(run).rejects.toThrow('EVAL aborted')
})
