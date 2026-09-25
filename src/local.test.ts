// local.ts overrides: loaded from the home at startup, optional, and able
// to replace config functions on module objects.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const srcDir = import.meta.dir

// Runs a script in a fresh process whose home is `home`, so the real
// repo-root local.ts (if the user has one) is never involved.
function run(home: string, script: string) {
	let out = Bun.spawnSync(['bun', '-e', script], {
		env: { ...process.env, HAL_HOME: home },
		timeout: 5000,
	})
	return { stdout: out.stdout.toString(), stderr: out.stderr.toString(), exitCode: out.exitCode }
}

const probe = `
let { main } = await import(${JSON.stringify(`${srcDir}/main.ts`)})
let { models } = await import(${JSON.stringify(`${srcDir}/host/models.ts`)})
let before = models.defaultModel()
await main.loadLocal()
console.log(JSON.stringify({ before, after: models.defaultModel() }))
`

function withHome(fn: (home: string) => void) {
	let home = mkdtempSync(join(tmpdir(), 'hal2-local-'))
	try {
		fn(home)
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
}

test('a missing local.ts is normal and changes nothing', () => {
	withHome((home) => {
		let out = run(home, probe)
		expect(out.stderr).toBe('')
		expect(out.exitCode).toBe(0)
		let { before, after } = JSON.parse(out.stdout)
		expect(after).toBe(before)
	})
})

test('local.ts replaces a config function read at call time', () => {
	withHome((home) => {
		writeFileSync(
			join(home, 'local.ts'),
			`import { models } from ${JSON.stringify(`${srcDir}/host/models.ts`)}\n` +
				`models.defaultModel = () => 'test/overridden'\n`,
		)
		let out = run(home, probe)
		expect(out.exitCode).toBe(0)
		let { before, after } = JSON.parse(out.stdout)
		expect(before).not.toBe('test/overridden')
		expect(after).toBe('test/overridden')
	})
})

test('a broken local.ts fails loudly instead of being ignored', () => {
	withHome((home) => {
		writeFileSync(join(home, 'local.ts'), `throw new Error('local-boom')\n`)
		let out = run(home, probe)
		expect(out.exitCode).not.toBe(0)
		expect(out.stderr).toContain('local-boom')
	})
})

test('start loads local.ts before initializing modules', () => {
	withHome((home) => {
		writeFileSync(join(home, 'local.ts'), `globalThis.localLoaded = true\n`)
		let script = `
let { main } = await import(${JSON.stringify(`${srcDir}/main.ts`)})
// Report and stop at init: without a tty, start would exit next.
main.init = () => {
	process.stderr.write('local-before-init=' + (globalThis.localLoaded === true))
	process.exit(0)
}
await main.start()
`
		let out = run(home, script)
		expect(out.exitCode).toBe(0)
		expect(out.stderr).toBe('local-before-init=true')
	})
})
