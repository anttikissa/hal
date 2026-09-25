import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('./run without a terminal says so and fails', () => {
	// A temp home keeps the user's real local.ts out of the test.
	let home = mkdtempSync(join(tmpdir(), 'hal2-main-'))
	try {
		let out = Bun.spawnSync(['./run'], {
			cwd: `${import.meta.dir}/..`,
			env: { ...process.env, HAL_HOME: home },
		})
		expect(out.exitCode).toBe(1)
		expect(out.stderr.toString()).toContain('terminal')
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})

test('./run starts again after a restart exit, and only then', () => {
	let home = mkdtempSync(join(tmpdir(), 'hal2-main-'))
	try {
		// local.ts runs on every start: the first two exit with the
		// restart code, the third with an ordinary failure code.
		let local = `import { appendFileSync, readFileSync } from 'fs'
import { terminal } from ${JSON.stringify(`${import.meta.dir}/client/terminal.ts`)}
let log = ${JSON.stringify(join(home, 'starts'))}
appendFileSync(log, 'x')
process.exit(readFileSync(log, 'utf8').length < 3 ? terminal.restartCode : 7)
`
		writeFileSync(join(home, 'local.ts'), local)
		let out = Bun.spawnSync(['./run'], {
			cwd: `${import.meta.dir}/..`,
			env: { ...process.env, HAL_HOME: home },
		})
		expect(out.exitCode).toBe(7)
		expect(Bun.file(join(home, 'starts')).size).toBe(3)
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})
