import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function sendCtrlC(proc: { stdin: any }) {
	proc.stdin!.write(new Uint8Array([0x03]))
	proc.stdin!.flush()
}

const HAL_DIR = join(import.meta.dir, '..')
const MAIN = join(HAL_DIR, 'src/main.ts')

let tmpDir: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'hal-test-'))
})

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

function spawnHal(env: Record<string, string | undefined>) {
	return Bun.spawn(['bun', MAIN], {
		stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
		env, cwd: HAL_DIR,
	})
}

function halEnv(): Record<string, string | undefined> {
	return { HAL_STATE_DIR: tmpDir, PATH: process.env.PATH, HOME: process.env.HOME }
}

function lockPid(): number | null {
	try {
		const raw = readFileSync(join(tmpDir, 'ipc/host.lock'), 'utf-8')
		const m = raw.match(/pid:\s*(\d+)/)
		return m ? Number(m[1]) : null
	} catch {
		return null
	}
}

function runtimeStartCount(): number {
	try {
		const content = readFileSync(join(tmpDir, 'ipc/events.asonl'), 'utf-8')
		return content.split('\n').filter(l => l.includes('runtime-start')).length
	} catch {
		return 0
	}
}

describe('host election', () => {
	test('exactly one host when 5 processes start simultaneously', async () => {
		const env = halEnv()
		const procs = Array.from({ length: 5 }, () => spawnHal(env))
		await Bun.sleep(600)

		expect(lockPid()).not.toBeNull()
		expect(runtimeStartCount()).toBe(1)

		for (const p of procs) sendCtrlC(p)
		await Promise.all(procs.map(p => p.exited))
	}, 10_000)

	test('client promotes to server when server dies', async () => {
		const env = halEnv()
		const server = spawnHal(env)
		await Bun.sleep(300)

		const client = spawnHal(env)
		await Bun.sleep(300)

		server.kill()
		await server.exited
		await Bun.sleep(500)

		expect(lockPid()).not.toBeNull()
		expect(runtimeStartCount()).toBe(2)

		sendCtrlC(client)
		await client.exited
	}, 10_000)

	test('exactly one promotion when server dies with 5 clients', async () => {
		const env = halEnv()
		const server = spawnHal(env)
		await Bun.sleep(300)

		const clients = Array.from({ length: 5 }, () => spawnHal(env))
		await Bun.sleep(300)

		server.kill()
		await server.exited
		await Bun.sleep(600)

		expect(lockPid()).not.toBeNull()
		expect(runtimeStartCount()).toBe(2)

		for (const c of clients) sendCtrlC(c)
		await Promise.all(clients.map(c => c.exited))
	}, 15_000)

	test('no dual server after kill-and-restart cycle', async () => {
		const env = halEnv()
		const server1 = spawnHal(env)
		await Bun.sleep(300)
		const client1 = spawnHal(env)
		await Bun.sleep(300)

		server1.kill()
		client1.kill()
		await Promise.all([server1.exited, client1.exited])
		const beforeRestart = runtimeStartCount()

		const proc1 = spawnHal(env)
		const proc2 = spawnHal(env)
		await Bun.sleep(500)

		expect(lockPid()).not.toBeNull()
		expect(runtimeStartCount()).toBe(beforeRestart + 1)

		sendCtrlC(proc1)
		sendCtrlC(proc2)
		await Promise.all([proc1.exited, proc2.exited])
	}, 15_000)

	test('stale lock from crashed process gets cleaned up', async () => {
		const env = halEnv()
		const server = spawnHal(env)
		await Bun.sleep(300)
		server.kill(9)
		await server.exited

		const stalePid = lockPid()
		expect(stalePid).not.toBeNull()

		const newProc = spawnHal(env)
		await Bun.sleep(500)

		expect(lockPid()).not.toBe(stalePid)
		expect(runtimeStartCount()).toBe(2)

		sendCtrlC(newProc)
		await newProc.exited
	}, 10_000)

	test('old host exits when another pid takes over the lock', async () => {
		const env = halEnv()
		const oldHost = spawnHal(env)
		await Bun.sleep(300)

		const firstPid = lockPid()
		expect(firstPid).not.toBeNull()

		unlinkSync(join(tmpDir, 'ipc/host.lock'))
		const newHost = spawnHal(env)
		await Bun.sleep(400)

		const secondPid = lockPid()
		expect(secondPid).not.toBeNull()
		expect(secondPid).not.toBe(firstPid)

		const oldExit = await Promise.race([
			oldHost.exited,
			Bun.sleep(1500).then(() => 'timeout'),
		])
		expect(oldExit).not.toBe('timeout')

		sendCtrlC(newHost)
		await newHost.exited
	}, 10_000)
})
