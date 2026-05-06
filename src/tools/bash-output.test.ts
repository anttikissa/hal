import { afterEach, expect, test } from 'bun:test'
import { bash } from './bash.ts'

const originalMaxOutputBytes = bash.config.maxOutputBytes

afterEach(() => {
	bash.config.maxOutputBytes = originalMaxOutputBytes
})

test('bash caps noisy stdout while draining the command', async () => {
	bash.config.maxOutputBytes = 2000

	const out = await bash.execute(
		{ command: "printf '%*s' 10000 '' | tr ' ' x" },
		{ sessionId: 's', cwd: process.cwd() },
	)

	expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2000)
	expect(out.endsWith('\n[… truncated]')).toBe(true)
})
