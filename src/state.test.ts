import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const NEW_DIR = resolve(import.meta.dir)
const scratch = mkdtempSync(join(tmpdir(), 'hal-state-test-'))
let scriptCounter = 0

function runScript(code: string, extraEnv: Record<string, string> = {}) {
	const file = join(scratch, `_state_test_${scriptCounter++}.ts`)
	writeFileSync(file, code)
	const env = { ...process.env, ...extraEnv } as Record<string, string>
	delete env.HAL_STATE_DIR
	if (extraEnv.HAL_STATE_DIR) env.HAL_STATE_DIR = extraEnv.HAL_STATE_DIR
	return Bun.spawn(['bun', file], {
		cwd: NEW_DIR,
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	})
}

async function runAndRead(code: string, extraEnv: Record<string, string> = {}) {
	const proc = runScript(code, extraEnv)
	const [out, err, codeNum] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { out: out.trim(), err: err.trim(), code: codeNum }
}

test('test mode without HAL_STATE_DIR uses isolated temp state dir', async () => {
	const { out, err, code } = await runAndRead(`
		import { STATE_DIR, ensureStateDir } from '${NEW_DIR}/state.ts'
		ensureStateDir()
		console.log(STATE_DIR)
	`, { NODE_ENV: 'test' })
	if (err) console.error(err)
	expect(code).toBe(0)
	expect(out).toContain('/hal-test-')
	rmSync(out, { recursive: true, force: true })
})

test('HAL_STATE_DIR is respected when provided', async () => {
	const custom = mkdtempSync(join(tmpdir(), 'hal-state-custom-'))
	const { out, err, code } = await runAndRead(`
		import { STATE_DIR } from '${NEW_DIR}/state.ts'
		console.log(STATE_DIR)
	`, { NODE_ENV: 'test', HAL_STATE_DIR: custom })
	if (err) console.error(err)
	expect(code).toBe(0)
	expect(out).toBe(custom)
	rmSync(custom, { recursive: true, force: true })
})

test('cleanup state test scratch', () => {
	rmSync(scratch, { recursive: true, force: true })
	expect(true).toBe(true)
})
