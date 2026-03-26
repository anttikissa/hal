import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

function sendCtrlC(proc: { stdin: any }) {
	proc.stdin!.write(new Uint8Array([0x03]))
	proc.stdin!.flush()
}

let tmpDir: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'hal-test-'))
})

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

describe('client-server', () => {
	test('client promotes to server when server dies', async () => {
		const halDir = join(import.meta.dir, '..')
		const env = {
			HAL_STATE_DIR: tmpDir,
			PATH: process.env.PATH,
			HOME: process.env.HOME,
		}

		// Start server
		const server = Bun.spawn(['bun', join(halDir, 'src/main.ts')], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		})
		await Bun.sleep(200)

		// Start client
		const client = Bun.spawn(['bun', join(halDir, 'src/main.ts')], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		})
		await Bun.sleep(200)

		// Kill server
		server.kill()
		await server.exited

		// Wait for client to promote
		await Bun.sleep(300)

		// Send prompt from the promoted client — it should handle it as server now
		client.stdin!.write('after promotion\n')
		client.stdin!.flush()
		await Bun.sleep(300)

		sendCtrlC(client)
		const clientOut = stripAnsi(await new Response(client.stdout).text())
		await client.exited

		expect(clientOut).toContain('Promoted to server')
		expect(clientOut).toContain('after promotion')
	})

	test('only one client promotes when server dies (no dual server)', async () => {
		const halDir = join(import.meta.dir, '..')
		const env = {
			HAL_STATE_DIR: tmpDir,
			PATH: process.env.PATH,
			HOME: process.env.HOME,
		}

		// Start server + two clients.
		const server = Bun.spawn(['bun', join(halDir, 'src/main.ts')], {
			stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env,
		})
		await Bun.sleep(200)

		const clientA = Bun.spawn(['bun', join(halDir, 'src/main.ts')], {
			stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env,
		})
		const clientB = Bun.spawn(['bun', join(halDir, 'src/main.ts')], {
			stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env,
		})
		await Bun.sleep(200)

		// Kill server — both clients should race to promote.
		server.kill()
		await server.exited
		await Bun.sleep(400)

		// Collect output from both.
		sendCtrlC(clientA)
		sendCtrlC(clientB)
		const outA = stripAnsi(await new Response(clientA.stdout).text())
		const outB = stripAnsi(await new Response(clientB.stdout).text())
		await Promise.all([clientA.exited, clientB.exited])

		// Exactly one should have promoted.
		const promotedA = outA.includes('Promoted to server')
		const promotedB = outB.includes('Promoted to server')
		expect(promotedA !== promotedB).toBe(true)
	})

	test('second process joins first', async () => {
		const halDir = join(import.meta.dir, '..')
		const env = {
			HAL_STATE_DIR: tmpDir,
			PATH: process.env.PATH,
			HOME: process.env.HOME,
		}

		// Start server
		const server = Bun.spawn(['bun', join(halDir, 'src/main.ts')], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		})

		await Bun.sleep(200)

		// Start client
		const client = Bun.spawn(['bun', join(halDir, 'src/main.ts')], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		})

		await Bun.sleep(200)

		// Send prompt from server
		server.stdin!.write('hello world\n')
		server.stdin!.flush()

		await Bun.sleep(1000)

		// Close both
		sendCtrlC(server)
		sendCtrlC(client)
		await Promise.all([server.exited, client.exited])

		const serverOut = stripAnsi(await new Response(server.stdout).text())
		const clientOut = stripAnsi(await new Response(client.stdout).text())

		// Both should see the prompt
		expect(serverOut).toContain('hello world')
		expect(clientOut).toContain('hello world')
	})
})
