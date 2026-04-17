import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

async function cleanup(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
	if (proc.exitCode !== null) return
	proc.kill()
	const exited = await Promise.race([
		proc.exited.then(() => true),
		Bun.sleep(500).then(() => false),
	])
	if (!exited) proc.kill(9)
	await proc.exited.catch(() => {})
}

test('hal exits when piped stdin closes', async () => {
	const stateDir = mkdtempSync(join(tmpdir(), 'hal-test-stdin-close-'))
	const proc = Bun.spawn(['bun', 'src/main.ts'], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			HAL_STATE_DIR: stateDir,
			PATH: process.env.PATH,
			HOME: process.env.HOME,
		},
	})
	try {
		await Bun.sleep(150)
		proc.stdin!.end()
		const code = await Promise.race([
			proc.exited,
			Bun.sleep(2_000).then(() => 'timeout' as const),
		])
		expect(code).not.toBe('timeout')
	} finally {
		await cleanup(proc)
		rmSync(stateDir, { recursive: true, force: true })
	}
})
