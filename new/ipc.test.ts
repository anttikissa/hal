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

function runScript(code: string) {
	const file = join(stateDir, '_test.ts')
	writeFileSync(file, code)
	return Bun.spawn(['bun', file], {
		cwd: NEW_DIR,
		env: { ...process.env, NEW_STATE_DIR: stateDir },
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

describe('host release', () => {
	test('releaseHost writes [host-released] to events.asonl', async () => {
		const { out, err } = await runAndRead(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, claimHost, releaseHost } from '${NEW_DIR}/ipc.ts'
			import { readFile } from 'fs/promises'

			ensureStateDir()
			await ensureBus()
			await claimHost('h1')
			await releaseHost('h1')

			const events = await readFile(process.env.NEW_STATE_DIR + '/ipc/events.asonl', 'utf-8')
			console.log(events.includes('[host-released]') ? 'PASS' : 'FAIL')
		`)
		if (err) console.error(err)
		expect(out).toBe('PASS')
	})

	test('host lock removed after releaseHost', async () => {
		const { out, err } = await runAndRead(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, claimHost, releaseHost } from '${NEW_DIR}/ipc.ts'
			import { existsSync } from 'fs'

			ensureStateDir()
			await ensureBus()
			await claimHost('h2')
			await releaseHost('h2')

			console.log(existsSync(process.env.NEW_STATE_DIR + '/ipc/host.lock') ? 'FAIL' : 'PASS')
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

	test('client promotes after host SIGKILL within 200ms', async () => {
		const hostProc = runScript(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, claimHost } from '${NEW_DIR}/ipc.ts'

			ensureStateDir()
			await ensureBus()
			const claim = await claimHost('h4')
			if (!claim.host) process.exit(1)
			console.log('READY')
			await new Promise(() => {})
		`)

		const reader = (hostProc.stdout as ReadableStream<Uint8Array>).getReader()
		const dec = new TextDecoder()
		let buf = ''
		while (!buf.includes('READY')) {
			const { value } = await reader.read()
			buf += dec.decode(value, { stream: true })
		}

		hostProc.kill('SIGKILL')
		await hostProc.exited

		const { out } = await runAndRead(`
			import { ensureStateDir } from '${NEW_DIR}/state.ts'
			import { ensureBus, claimHost } from '${NEW_DIR}/ipc.ts'

			ensureStateDir()
			await ensureBus()
			const start = Date.now()
			const result = await claimHost('c1')
			const elapsed = Date.now() - start
			console.log(result.host ? 'PROMOTED ' + elapsed : 'FAIL')
		`)
		expect(out).toStartWith('PROMOTED')
		const elapsed = parseInt(out.split(' ')[1])
		expect(elapsed).toBeLessThan(200)
	})
})