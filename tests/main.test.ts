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
		expect(stdout).toContain('You said: hello')
	})

	test('exits with 100 on ctrl-r', async () => {
		const proc = spawnHal()
		await Bun.sleep(100)
		proc.stdin!.write(new Uint8Array([0x12]))
		proc.stdin!.flush()
		const code = await proc.exited
		expect(code).toBe(100)
	})
})
