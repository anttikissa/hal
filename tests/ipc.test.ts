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
		expect(clientOut).toContain('You said: after promotion')
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

		await Bun.sleep(300)

		// Close both
		sendCtrlC(server)
		sendCtrlC(client)
		await Promise.all([server.exited, client.exited])

		const serverOut = stripAnsi(await new Response(server.stdout).text())
		const clientOut = stripAnsi(await new Response(client.stdout).text())

		// Both should see the prompt and response
		expect(serverOut).toContain('hello world')
		expect(clientOut).toContain('hello world')
		expect(serverOut).toContain('You said: hello world')
		expect(clientOut).toContain('You said: hello world')
	})
})
