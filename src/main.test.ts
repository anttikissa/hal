import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

test('a restart finds the tab it left; a fresh ./run starts without one', () => {
	let home = mkdtempSync(join(tmpdir(), 'hal2-main-'))
	try {
		// Each start reports what it would come back to, then keeps a tab
		// of its own and restarts; the third stops.
		let local = `import { appendFileSync } from 'fs'
import { main } from ${JSON.stringify(`${import.meta.dir}/main.ts`)}
import { terminal } from ${JSON.stringify(`${import.meta.dir}/client/terminal.ts`)}
let log = ${JSON.stringify(join(home, 'starts'))}
let prev = main.lastTab()
appendFileSync(log, JSON.stringify(prev) + '\\n')
let n = prev.last ? Number(prev.last.slice(1)) + 1 : 1
main.keepTab({ id: 't' + n, name: '', cwd: '/c' + n, model: '', state: { type: 'idle' } })
process.exit(n < 3 ? terminal.restartCode : 7)
`
		writeFileSync(join(home, 'local.ts'), local)
		let run = () => Bun.spawnSync(['./run'], { cwd: `${import.meta.dir}/..`, env: { ...process.env, HAL_HOME: home } })
		expect(run().exitCode).toBe(7)
		expect(run().exitCode).toBe(7)
		let starts = readFileSync(join(home, 'starts'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
		expect(starts).toEqual([{}, { last: 't1', cwd: '/c1' }, { last: 't2', cwd: '/c2' }, {}, { last: 't1', cwd: '/c1' }, { last: 't2', cwd: '/c2' }])
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})

test('work held for the first tab runs after it is shown, or after laterMs without it', async () => {
	let { main } = await import('./main.ts')
	let saved = { ...main.state, later: [...main.state.later] }
	let savedMs = main.laterMs
	try {
		let ran: string[] = []
		Object.assign(main.state, { shown: false, later: [], fallback: undefined })
		main.laterMs = () => 5_000
		main.later(() => ran.push('web'))
		await Bun.sleep(5)
		expect(ran).toEqual([])
		main.shown()
		await Bun.sleep(5)
		expect(ran).toEqual(['web'])
		main.later(() => ran.push('after'))
		await Bun.sleep(5)
		expect(ran).toEqual(['web', 'after'])

		Object.assign(main.state, { shown: false, later: [], fallback: undefined })
		main.laterMs = () => 10
		main.later(() => ran.push('late'))
		await Bun.sleep(40)
		expect(ran.at(-1)).toBe('late')
	} finally {
		if (main.state.fallback) clearTimeout(main.state.fallback)
		Object.assign(main.state, saved)
		main.laterMs = savedMs
	}
})
