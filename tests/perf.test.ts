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

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "")
}

describe("perf", () => {
	test("perf marks appear in output", async () => {
		const proc = Bun.spawn(["bun", "src/main.ts"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				HAL_STATE_DIR: tmpDir,
				PATH: process.env.PATH,
				HOME: process.env.HOME,
			},
		})
		// Wait for perf flush (100ms interval)
		await Bun.sleep(300)
		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		const out = stripAnsi(await new Response(proc.stdout).text())
		await proc.exited
		expect(out).toContain("First line of code executed")
		expect(out).toContain("State directories exist")
		expect(out).toContain("Host status established")
		expect(out).toContain("Client ready to read input")
	})
})
