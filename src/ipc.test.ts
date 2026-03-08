import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const NEW_DIR = resolve(import.meta.dir)
let stateDir: string

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), 'hal-ipc-test-'))
})

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true })
})

let scriptCounter = 0
function runScript(code: string) {
	const file = join(stateDir, `_test${scriptCounter++}.ts`)
	writeFileSync(file, code)
	return Bun.spawn(['bun', file], {
		cwd: NEW_DIR,
		env: { ...process.env, HAL_STATE_DIR: stateDir },
		stdout: 'pipe',
		stderr: 'pipe',
	})
}

async function runAndRead(code: string): Promise<{ out: string; err: string; exitCode: number }> {
	const proc = runScript(code)
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	const exitCode = await proc.exited
	return { out: out.trim(), err: err.trim(), exitCode }
}

describe('ipc host lifecycle', () => {
	test('releaseHost writes [host-released] to events.asonl', async () => {
		const { out, err } = await runAndRead(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, claimHost, releaseHost } from '${NEW_DIR}/ipc.ts'
			import { readFile } from 'fs/promises'

			ensureStateDir()
			await ensureBus()
			await claimHost('h1')
			await releaseHost('h1')

			const events = await readFile(process.env.HAL_STATE_DIR + '/ipc/events.asonl', 'utf-8')
			console.log(events.includes('[host-released]') ? 'PASS' : 'FAIL')
		`)
		if (err) console.error(err)
		expect(out).toBe('PASS')
	})

	test('lock released after releaseHost', async () => {
		const { out, err } = await runAndRead(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, claimHost, releaseHost } from '${NEW_DIR}/ipc.ts'

			ensureStateDir()
			await ensureBus()
			await claimHost('h2')
			await releaseHost('h2')

			const result = await claimHost('h3')
			console.log(result.host ? 'PASS' : 'FAIL')
		`)
		if (err) console.error(err)
		expect(out).toBe('PASS')
	})

	test('SIGTERM triggers releaseHost and writes event', async () => {
		const hostProc = runScript(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, claimHost, releaseHost } from '${NEW_DIR}/ipc.ts'

			ensureStateDir()
			await ensureBus()
			const claim = await claimHost('h3')
			if (!claim.host) process.exit(1)
			console.log('READY')

			process.on('SIGTERM', async () => {
				await releaseHost('h3')
				process.exit(0)
			})
			await new Promise(() => {})
		`)

		const reader = (hostProc.stdout as ReadableStream<Uint8Array>).getReader()
		const dec = new TextDecoder()
		let buf = ''
		while (!buf.includes('READY')) {
			const { value } = await reader.read()
			buf += dec.decode(value, { stream: true })
		}

		hostProc.kill('SIGTERM')
		await hostProc.exited

		const events = await readFile(join(stateDir, 'ipc/events.asonl'), 'utf-8')
		expect(events).toContain('[host-released]')
	})

	test('stale lock from dead pid can be reclaimed', async () => {
		const { out, err } = await runAndRead(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, claimHost } from '${NEW_DIR}/ipc.ts'
			import { writeFileSync } from 'fs'

			ensureStateDir()
			await ensureBus()
			writeFileSync(process.env.HAL_STATE_DIR + '/ipc/host.lock', "{ hostId: 'ghost', pid: 2147483647, createdAt: '2020-01-01T00:00:00.000Z' }\\n")
			const result = await claimHost('h5')
			console.log(result.host ? 'PASS' : 'FAIL')
		`)
		if (err) console.error(err)
		expect(out).toBe('PASS')
	})

	test('invalid lock file can be reclaimed', async () => {
		const { out, err } = await runAndRead(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, claimHost } from '${NEW_DIR}/ipc.ts'
			import { writeFileSync } from 'fs'

			ensureStateDir()
			await ensureBus()
			writeFileSync(process.env.HAL_STATE_DIR + '/ipc/host.lock', '{ hostId:')
			const result = await claimHost('h6')
			console.log(result.host ? 'PASS' : 'FAIL')
		`)
		if (err) console.error(err)
		expect(out).toBe('PASS')
	})
})

describe('ipc state persistence', () => {
	test('updateState persists immediately to state.ason', async () => {
		const { out, err } = await runAndRead(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, updateState } from '${NEW_DIR}/ipc.ts'
			import { readFile } from 'fs/promises'
			import { parse } from '${NEW_DIR}/utils/ason.ts'

			ensureStateDir()
			await ensureBus()
			updateState((s) => { s.sessions = ['s-a', 's-b']; s.activeSessionId = 's-b' })
			const raw = await readFile(process.env.HAL_STATE_DIR + '/ipc/state.ason', 'utf-8')
			const disk = parse(raw) as any
			console.log(disk.activeSessionId === 's-b' && disk.sessions?.length === 2 ? 'PASS' : 'FAIL')
		`)
		if (err) console.error(err)
		expect(out).toBe('PASS')
	})
})
