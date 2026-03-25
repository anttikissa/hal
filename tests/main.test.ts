import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let tmpDir: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'hal-test-'))
})

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

function spawnHal() {
	return Bun.spawn(['bun', 'src/main.ts'], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			HAL_STATE_DIR: tmpDir,
			PATH: process.env.PATH,
			HOME: process.env.HOME,
		},
	})
}

describe('main', () => {
	test('echoes input via events', async () => {
		const proc = spawnHal()
		await Bun.sleep(100)
		proc.stdin!.write('hello\n')
		proc.stdin!.flush()
		await Bun.sleep(200)
		// Send ctrl-c to quit
		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		const stdout = stripAnsi(await new Response(proc.stdout).text())
		await proc.exited
		expect(stdout).toContain('hello')
		// The stub provider responds with a placeholder until Plan 4
		expect(stdout).toContain('Provider not yet implemented')
	})

	test('exits with 100 on ctrl-r', async () => {
		const proc = spawnHal()
		await Bun.sleep(100)
		proc.stdin!.write(new Uint8Array([0x12]))
		proc.stdin!.flush()
		const code = await proc.exited
		expect(code).toBe(100)
	})

	test('does not replay events from previous runtime', async () => {
		const marker = `marker-${Date.now()}`

		const first = spawnHal()
		await Bun.sleep(100)
		first.stdin!.write(`${marker}\n`)
		first.stdin!.flush()
		await Bun.sleep(300)
		first.stdin!.write(new Uint8Array([0x03]))
		first.stdin!.flush()
		await first.exited

		const second = spawnHal()
		await Bun.sleep(250)
		second.stdin!.write(new Uint8Array([0x03]))
		second.stdin!.flush()
		const stdout = stripAnsi(await new Response(second.stdout).text())
		await second.exited

		expect(stdout).not.toContain(marker)
	})
})
