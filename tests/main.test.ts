import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ason } from '../src/utils/ason.ts'
import { cleanupSpawned } from './process-cleanup.ts'

let tmpDir: string
let procs: Array<ReturnType<typeof Bun.spawn>>

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'hal-test-'))
	procs = []
})

afterEach(async () => {
	await cleanupSpawned(procs)
	rmSync(tmpDir, { recursive: true, force: true })
})

function stripAnsi(s: string) {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

function spawnHal() {
	const proc = Bun.spawn(['bun', 'src/main.ts'], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			HAL_STATE_DIR: tmpDir,
			PATH: process.env.PATH,
			HOME: process.env.HOME,
		},
	})
	procs.push(proc)
	return proc
}


async function readOnlySessionHistory(): Promise<any[]> {
	const text = readFileSync(await waitForOnlySessionHistoryPath(), 'utf-8')
	return text
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => ason.parse(line))
}

async function waitForOnlySessionHistoryPath(): Promise<string> {
	const deadline = Date.now() + 2000
	while (Date.now() < deadline) {
		const sessionsDir = join(tmpDir, 'sessions')
		const ids = existsSync(sessionsDir) ? readdirSync(sessionsDir) : []
		if (ids.length === 1) {
			const path = join(sessionsDir, ids[0]!, 'history.asonl')
			if (existsSync(path)) return path
		}
		await Bun.sleep(50)
	}
	throw new Error('Timed out waiting for history.asonl')
}

describe('main', () => {
	test('echoes input via events', async () => {
		const proc = spawnHal()
		await Bun.sleep(100)
		proc.stdin!.write('hello\n')
		proc.stdin!.flush()
		await Bun.sleep(200)
		// Send ctrl-c to quit
		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		const stdout = stripAnsi(await new Response(proc.stdout).text())
		await proc.exited
		expect(stdout).toContain('hello')
	})

	test('exits with 100 on ctrl-r', async () => {
		const proc = spawnHal()
		await Bun.sleep(100)
		proc.stdin!.write(new Uint8Array([0x12]))
		proc.stdin!.flush()
		const code = await proc.exited
		expect(code).toBe(100)
	})


	test('persists history across restarts', async () => {
		const marker = `marker-${Date.now()}`

		const first = spawnHal()
		await Bun.sleep(250)
		first.stdin!.write(`${marker}\n`)
		first.stdin!.flush()
		await Bun.sleep(350)
		first.stdin!.write(new Uint8Array([0x03]))
		first.stdin!.flush()
		await first.exited

		const second = spawnHal()
		await Bun.sleep(250)
		second.stdin!.write(new Uint8Array([0x03]))
		second.stdin!.flush()
		const stdout = stripAnsi(await new Response(second.stdout).text())
		await second.exited

		// History is now persisted, so the marker should appear on restart
		expect(stdout).toContain(marker)
	})

	test('persists failed slash commands for retry history', async () => {
		const first = spawnHal()
		await Bun.sleep(250)
		first.stdin!.write('/nope\r')
		first.stdin!.flush()
		await Bun.sleep(1000)
		first.stdin!.write(new Uint8Array([0x03]))
		first.stdin!.flush()
		await first.exited

		const history = await readOnlySessionHistory()
		expect(history).toContainEqual(expect.objectContaining({
			type: 'input_history',
			text: '/nope',
		}))
	})

})

	test('ctrl-m opens the model picker on kitty terminals', async () => {
		const proc = Bun.spawn(['bun', 'src/main.ts'], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env: {
				HAL_STATE_DIR: tmpDir,
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				TERM_PROGRAM: 'iTerm.app',
			},
		})
		procs.push(proc)
		await Bun.sleep(150)
		proc.stdin!.write('\x1b[109;5u')
		proc.stdin!.flush()
		await Bun.sleep(150)
		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		const stdout = stripAnsi(await new Response(proc.stdout).text())
		await proc.exited
		expect(stdout).toContain('Pick a model')
	})
