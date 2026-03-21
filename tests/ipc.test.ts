import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let tmpDir: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "hal-test-"))
})

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

describe("client-server", () => {
	test("client promotes to server when server dies", async () => {
		const halDir = join(import.meta.dir, "..")
		const env = { HAL_STATE_DIR: tmpDir, PATH: process.env.PATH, HOME: process.env.HOME }

		// Start server
		const server = Bun.spawn(["bun", join(halDir, "src/main.ts")], {
			stdin: "pipe", stdout: "pipe", stderr: "pipe", env,
		})
		await Bun.sleep(200)

		// Start client
		const client = Bun.spawn(["bun", join(halDir, "src/main.ts")], {
			stdin: "pipe", stdout: "pipe", stderr: "pipe", env,
		})
		await Bun.sleep(200)

		// Kill server
		server.kill()
		await server.exited

		// Wait for client to promote
		await Bun.sleep(300)

		// Send prompt from the promoted client — it should handle it as server now
		client.stdin!.write("after promotion\n")
		client.stdin!.flush()
		await Bun.sleep(300)

		client.stdin!.end()
		const clientOut = await new Response(client.stdout).text()
		await client.exited

		expect(clientOut).toContain("Promoted to server")
		expect(clientOut).toContain("You: after promotion")
		expect(clientOut).toContain("Assistant: You said: after promotion")
	})

	test("second process joins first", async () => {
		const halDir = join(import.meta.dir, "..")
		const env = { HAL_STATE_DIR: tmpDir, PATH: process.env.PATH, HOME: process.env.HOME }

		// Start server
		const server = Bun.spawn(["bun", join(halDir, "src/main.ts")], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		})

		await Bun.sleep(200)

		// Start client
		const client = Bun.spawn(["bun", join(halDir, "src/main.ts")], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		})

		await Bun.sleep(200)

		// Send prompt from server
		server.stdin!.write("hello world\n")
		server.stdin!.flush()

		await Bun.sleep(300)

		// Close both
		server.stdin!.end()
		client.stdin!.end()
		await Promise.all([server.exited, client.exited])

		const serverOut = await new Response(server.stdout).text()
		const clientOut = await new Response(client.stdout).text()

		// Server should show it's the server
		expect(serverOut).toContain("Server started")
		// Client should show it joined
		expect(clientOut).toContain("Joined")
		// Both should see the prompt and response
		expect(serverOut).toContain("You: hello world")
		expect(clientOut).toContain("You: hello world")
		expect(serverOut).toContain("Assistant: You said: hello world")
		expect(clientOut).toContain("Assistant: You said: hello world")
	})
})
