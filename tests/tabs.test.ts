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

function spawnHal() {
	return Bun.spawn(["bun", "src/main.ts"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			HAL_STATE_DIR: tmpDir,
			PATH: process.env.PATH,
			HOME: process.env.HOME,
		},
	})
}

describe("tabs", () => {
	test("starts with one tab", async () => {
		const proc = spawnHal()
		await Bun.sleep(300)
		proc.stdin!.write(new Uint8Array([0x03])) // ctrl-c
		proc.stdin!.flush()
		const out = stripAnsi(await new Response(proc.stdout).text())
		await proc.exited
		expect(out).toContain("[1 tab 1]")
	})

	test("ctrl-t creates a new tab", async () => {
		const proc = spawnHal()
		await Bun.sleep(200)
		// Ctrl-T
		proc.stdin!.write(new Uint8Array([0x14]))
		proc.stdin!.flush()
		await Bun.sleep(300)
		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		const out = stripAnsi(await new Response(proc.stdout).text())
		await proc.exited
		// Should show two tabs
		expect(out).toContain(" 1 tab 1 ")
		expect(out).toContain("[2 tab 2]")
	})
})
