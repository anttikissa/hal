import { describe, test, expect } from 'bun:test'
import { spawn } from 'bun'

describe('cli input latency', () => {
	test('keypress to render < 50ms', async () => {
		const proc = spawn(['bun', 'new/cli.ts'], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		})

		// Wait for initial render
		await Bun.sleep(500)

		// Drain initial output
		const reader = proc.stdout.getReader()
		const drain = async () => {
			while (true) {
				const result = await Promise.race([
					reader.read(),
					Bun.sleep(100).then(() => null),
				])
				if (!result || result.done) break
			}
		}
		await drain()

		// Type characters and measure latency for each
		const keys = [
			...'sdfkjsdf'.split(''),
			'\x1b[D', '\x1b[D', '\x1b[D', // cursor left x3
		]

		for (const key of keys) {
			const start = performance.now()
			proc.stdin.write(key)
			const result = await Promise.race([
				reader.read(),
				Bun.sleep(200).then(() => null),
			])
			const elapsed = performance.now() - start
			expect(result).not.toBeNull()
			expect(elapsed).toBeLessThan(50)
		}

		// Clean up
		proc.stdin.write('\x03')
		proc.kill()
	})
})
