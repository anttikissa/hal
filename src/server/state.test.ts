import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

test('test env state is temp', () => {
	const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>
	delete env.HAL_STATE_DIR
	const result = Bun.spawnSync({
		cmd: ['bun', '-e', "import { STATE_DIR } from './src/server/state.ts'; process.stdout.write(STATE_DIR)"],
		cwd: root,
		env,
		stderr: 'pipe',
		stdout: 'pipe',
	})

	expect(result.exitCode).toBe(0)
	expect(result.stdout.toString()).toContain('hal-test-state-')
	expect(result.stdout.toString()).not.toBe(`${root}/state`)
})

// State holds conversation transcripts and IPC sockets, so it must not be readable by other local
// users. Pre-existing dirs are tightened too, since most installs already created them as 0755.
test('state dir is private to the user, including when it already exists', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-state-mode-'))
	const stateDir = join(dir, 'state')
	mkdirSync(stateDir, { mode: 0o755 })
	const result = Bun.spawnSync({
		cmd: ['bun', '-e', "import { ensureStateDir } from './src/server/state.ts'; ensureStateDir()"],
		cwd: root,
		env: { ...process.env, HAL_STATE_DIR: stateDir } as Record<string, string>,
		stderr: 'pipe',
		stdout: 'pipe',
	})

	expect(result.stderr.toString()).toBe('')
	expect(statSync(stateDir).mode & 0o777).toBe(0o700)
	expect(statSync(join(stateDir, 'ipc')).mode & 0o777).toBe(0o700)
	rmSync(dir, { force: true, recursive: true })
})
