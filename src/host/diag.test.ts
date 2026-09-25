import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { diag } from './diag.ts'
import { paths } from './paths.ts'

const saved = process.env.HAL_HOME
let home = ''

afterEach(() => {
	if (saved === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = saved
	rmSync(home, { recursive: true, force: true })
})

test('diagnostics land redacted in owner-only state/, not in sessions/', () => {
	home = mkdtempSync(`${tmpdir()}/hal-diag-`)
	process.env.HAL_HOME = home
	paths.init()
	let token = 'sk-ant-api03-Qw3rTy0123456789abcdefXYZ'
	diag.log(`refresh failed for ${token}`)
	diag.log('second line')
	expect(diag.file().startsWith(`${paths.stateDir()}/`)).toBe(true)
	let text = readFileSync(diag.file(), 'utf8')
	expect(text).not.toContain(token)
	expect(text).toContain('refresh failed for [redacted]')
	expect(text.trim().split('\n')).toHaveLength(2)
	expect(statSync(diag.file()).mode & 0o077).toBe(0)
	expect(readdirSync(paths.sessionsDir())).toEqual([])
})

test('logging prints nothing', () => {
	home = mkdtempSync(`${tmpdir()}/hal-diag-`)
	let script = [
		`import { paths } from ${JSON.stringify(`${import.meta.dir}/paths.ts`)}`,
		`import { diag } from ${JSON.stringify(`${import.meta.dir}/diag.ts`)}`,
		`paths.init(); diag.log('hello')`,
	].join('\n')
	let out = Bun.spawnSync(['bun', '-e', script], { env: { ...process.env, HAL_HOME: home } })
	expect(out.exitCode).toBe(0)
	expect(out.stdout.toString() + out.stderr.toString()).toBe('')
	expect(existsSync(`${home}/state/diag.log`)).toBe(true)
})
