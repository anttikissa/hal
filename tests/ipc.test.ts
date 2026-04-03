import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

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

/** Read the lock file and return the holder's PID, or null. */
function lockPid(): number | null {
	try {
		const raw = readFileSync(join(tmpDir, 'ipc/host.lock'), 'utf-8')
		const m = raw.match(/pid:\s*(\d+)/)
		return m ? Number(m[1]) : null
	} catch { return null }
}

/** Count runtime-start events in the events log. */
function runtimeStartCount(): number {
	try {
		const content = readFileSync(join(tmpDir, 'ipc/events.asonl'), 'utf-8')
		return content.split('\n').filter(l => l.includes('runtime-start')).length
	} catch { return 0 }
}

/** Count promote events in the events log. */
function promoteCount(): number {
	try {
		const content = readFileSync(join(tmpDir, 'ipc/events.asonl'), 'utf-8')
		return content.split('\n').filter(l => l.includes("type: 'promote'")).length
	} catch { return 0 }
}

describe('host election', () => {
	test('exactly one host when 5 processes start simultaneously', async () => {
		const env = halEnv()
		const procs = Array.from({ length: 5 }, () => spawnHal(env))
		await Bun.sleep(600)

		// Exactly one lock holder
		const pid = lockPid()
		expect(pid).not.toBeNull()

		// Exactly one runtime-start event
		expect(runtimeStartCount()).toBe(1)

		// Kill all
		for (const p of procs) { sendCtrlC(p) }
		const outputs = await Promise.all(procs.map(async p => {
			const out = stripAnsi(await new Response(p.stdout).text())
			await p.exited
			return out
		}))

		// Exactly one should say "I am host"
		const hosts = outputs.filter(o => o.includes('I am host'))
		expect(hosts.length).toBe(1)
	}, 10_000)

	test('client promotes to server when server dies', async () => {
		const env = halEnv()
		const server = spawnHal(env)
		await Bun.sleep(300)

		const client = spawnHal(env)
		await Bun.sleep(300)

		// Kill server
		server.kill()
		await server.exited
		await Bun.sleep(500)

		// Client should have promoted
		sendCtrlC(client)
		const clientOut = stripAnsi(await new Response(client.stdout).text())
		await client.exited

		expect(clientOut).toContain('Promoted to server')
	}, 10_000)

	test('exactly one promotion when server dies with 5 clients', async () => {
		const env = halEnv()
		const server = spawnHal(env)
		await Bun.sleep(300)

		const clients = Array.from({ length: 5 }, () => spawnHal(env))
		await Bun.sleep(300)

		// Kill server — all clients race to promote
		server.kill()
		await server.exited
		await Bun.sleep(600)

		// Exactly one lock holder, and it's alive
		const pid = lockPid()
		expect(pid).not.toBeNull()

		// Exactly one promote event
		expect(promoteCount()).toBe(1)

		// Kill all clients
		for (const c of clients) { sendCtrlC(c) }
		const outputs = await Promise.all(clients.map(async c => {
			const out = stripAnsi(await new Response(c.stdout).text())
			await c.exited
			return out
		}))

		// Exactly one promoted
		const promoted = outputs.filter(o => o.includes('Promoted to server'))
		expect(promoted.length).toBe(1)
	}, 15_000)

	test('no dual server after kill-and-restart cycle', async () => {
		const env = halEnv()

		// Start initial server + client (simulate the old dual-host bug state)
		const server1 = spawnHal(env)
		await Bun.sleep(300)
		const client1 = spawnHal(env)
		await Bun.sleep(300)

		// Kill both rapidly — simulates user quitting both terminals
		server1.kill()
		client1.kill()
		await Promise.all([server1.exited, client1.exited])

		// Immediately start two new processes (before lock cleanup settles)
		const proc1 = spawnHal(env)
		const proc2 = spawnHal(env)
		await Bun.sleep(500)

		// Exactly one host
		expect(runtimeStartCount()).toBeGreaterThanOrEqual(2) // one from first server, one from new
		const pid = lockPid()
		expect(pid).not.toBeNull()

		sendCtrlC(proc1)
		sendCtrlC(proc2)
		const out1 = stripAnsi(await new Response(proc1.stdout).text())
		const out2 = stripAnsi(await new Response(proc2.stdout).text())
		await Promise.all([proc1.exited, proc2.exited])

		// Exactly one of the new pair should be host
		const host1 = out1.includes('I am host')
		const host2 = out2.includes('I am host')
		expect(host1 !== host2).toBe(true)
	}, 15_000)

	test('stale lock from crashed process gets cleaned up', async () => {
		const env = halEnv()

		// Start and hard-kill (SIGKILL) — no cleanup runs
		const server = spawnHal(env)
		await Bun.sleep(300)
		server.kill(9) // SIGKILL
		await server.exited

		// Lock file should still exist with dead PID
		const stalePid = lockPid()
		expect(stalePid).not.toBeNull()

		// New process should detect stale lock and claim host
		const newProc = spawnHal(env)
		await Bun.sleep(500)

		sendCtrlC(newProc)
		const out = stripAnsi(await new Response(newProc.stdout).text())
		await newProc.exited

		expect(out).toContain('I am host')
	}, 10_000)
})
