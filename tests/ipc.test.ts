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
