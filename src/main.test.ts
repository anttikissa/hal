import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('./run starts the app', () => {
	// A temp home keeps the user's real local.ts out of the test.
	let home = mkdtempSync(join(tmpdir(), 'hal2-main-'))
	try {
		let out = Bun.spawnSync(['./run'], {
			cwd: `${import.meta.dir}/..`,
			env: { ...process.env, HAL_HOME: home },
		})
		expect(out.exitCode).toBe(0)
		expect(out.stdout.toString()).toBe('hal2\n')
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})
