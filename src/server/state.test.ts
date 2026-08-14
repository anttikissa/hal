import { expect, test } from 'bun:test'
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
