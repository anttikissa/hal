import { describe, test, expect } from "bun:test"

describe("main", () => {
	test("echoes input", async () => {
		const proc = Bun.spawn(["bun", "src/main.ts"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		})
		proc.stdin.write("hello\n")
		proc.stdin.flush()
		proc.stdin.end()
		const stdout = await new Response(proc.stdout).text()
		await proc.exited
		expect(stdout).toContain("You said: hello")
	})

	test("exits with 100 on ctrl-r", async () => {
		const proc = Bun.spawn(["bun", "src/main.ts"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		})
		proc.stdin.write(new Uint8Array([0x12]))
		proc.stdin.flush()
		const code = await proc.exited
		expect(code).toBe(100)
	})

	test("run script restarts on exit code 100", async () => {
		// Send ctrl-r twice: first triggers restart, second exits the restarted process
		const halDir = import.meta.dir + "/.."
		const proc = Bun.spawn(["bash", "-c", `
			count=0
			while true; do
				count=$((count + 1))
				echo "start $count"
				bun "${halDir}/src/main.ts"
				code=$?
				[ "$code" -ne 100 ] && break
			done
		`], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		})
		// First ctrl-r triggers restart
		await new Promise(r => setTimeout(r, 100))
		proc.stdin.write(new Uint8Array([0x12]))
		proc.stdin.flush()
		// Second ctrl-r on the restarted process, then close stdin to exit
		await new Promise(r => setTimeout(r, 100))
		proc.stdin.write(new Uint8Array([0x12]))
		proc.stdin.flush()
		await new Promise(r => setTimeout(r, 100))
		proc.stdin.end()
		const stdout = await new Response(proc.stdout).text()
		await proc.exited
		// Should have started at least twice
		expect(stdout).toContain("start 1")
		expect(stdout).toContain("start 2")
	})
})
