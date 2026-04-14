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
	return s
		.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-_])/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
		.replace(/\r/g, "")
}

describe("perf", () => {
	test("startup summary appears in output", async () => {
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
		// Wait for startup summary to render
		await Bun.sleep(500)
		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		const out = stripAnsi(await new Response(proc.stdout).text())
		await proc.exited
		// The new startup block shows "Server started (pid X) · ready Yms"
		// followed by detail timings like "replay", "first draw", etc.
		expect(out).toContain("Server started")
		expect(out).toContain("ready")
		expect(out).toMatch(/\d+\.\d+ms/)
	})
})
