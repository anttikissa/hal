import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { ason } from "../src/utils/ason.ts"

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

function readSessionIds(): string[] {
	const text = readFileSync(join(tmpDir, "ipc", "state.ason"), "utf-8")
	const state = ason.parse(text) as { sessions?: string[] }
	return state.sessions ?? []
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

	test("ctrl-f forks the current tab", async () => {
		const proc = spawnHal()
		await Bun.sleep(300)

		const before = readSessionIds()
		expect(before).toHaveLength(1)
		const parentId = before[0]!

		proc.stdin!.write(new Uint8Array([0x06])) // ctrl-f
		proc.stdin!.flush()
		const deadline = Date.now() + 2000
		while (Date.now() < deadline) {
			const current = readSessionIds()
			if (current.length === 2 && current[0] === parentId) break
			await Bun.sleep(50)
		}

		const after = readSessionIds()
		expect(after).toHaveLength(2)
		expect(after[0]).toBe(parentId)
		const childId = after[1]!
		expect(childId).not.toBe(parentId)

		const childLog = readFileSync(join(tmpDir, "sessions", childId, "history.asonl"), "utf-8")
		expect(childLog).toContain("forked_from")
		expect(childLog).toContain(parentId)

		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		await proc.exited
	})
})
