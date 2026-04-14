import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs"
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
	return s
		.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-_])/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
		.replace(/\r/g, "")
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
	const path = join(tmpDir, "ipc", "state.ason")
	if (!existsSync(path)) return []
	const text = readFileSync(path, "utf-8")
	const state = ason.parse(text) as { sessions?: string[] }
	return state.sessions ?? []
}

function readHistory(sessionId: string): any[] {
	const text = readFileSync(join(tmpDir, "sessions", sessionId, "history.asonl"), "utf-8").trim()
	if (!text) return []
	return text.split("\n").map((line) => ason.parse(line))
}

async function waitForHistory(sessionId: string): Promise<any[]> {
	const deadline = Date.now() + 2000
	while (Date.now() < deadline) {
		const path = join(tmpDir, "sessions", sessionId, "history.asonl")
		if (existsSync(path)) return readHistory(sessionId)
		await Bun.sleep(50)
	}
	throw new Error(`Timed out waiting for history for ${sessionId}`)
}


describe("tabs", () => {
	test("starts with one tab", async () => {
		const proc = spawnHal()
		await Bun.sleep(500)
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

	test("new tabs record who opened them", async () => {
		const proc = spawnHal()
		await Bun.sleep(300)

		const before = readSessionIds()
		expect(before).toHaveLength(1)
		const openerId = before[0]!

		proc.stdin!.write(new Uint8Array([0x14])) // ctrl-t
		proc.stdin!.flush()

		const deadline = Date.now() + 2000
		while (Date.now() < deadline) {
			if (readSessionIds().length === 2) break
			await Bun.sleep(50)
		}

		const after = readSessionIds()
		expect(after).toHaveLength(2)
		const childId = after[1]!
		const childHistory = await waitForHistory(childId)
		const first = childHistory[0]

		expect(first).toMatchObject({ type: 'info' })
		expect(first?.text).toContain('User opened a new tab')
		expect(first?.text).toContain('tab 2')
		expect(first?.text).toContain(childId)
		expect(first?.text).toContain('tab 1')
		expect(first?.text).toContain(openerId)

		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		await proc.exited
	})

	test("ctrl-f forks the current tab", async () => {
		const proc = spawnHal()
		await Bun.sleep(300)

		const before = readSessionIds()
		expect(before).toHaveLength(1)
		const parentId = before[0]!

		const parentDir = join(tmpDir, "sessions", parentId)
		const readyDeadline = Date.now() + 2000
		while (Date.now() < readyDeadline) {
			if (existsSync(join(parentDir, "session.ason")) && existsSync(join(parentDir, "history.asonl"))) break
			await Bun.sleep(50)
		}

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


	test("fork inserts the new tab next to its parent", async () => {
		const proc = spawnHal()
		await Bun.sleep(300)

		proc.stdin!.write(new Uint8Array([0x14])) // ctrl-t
		proc.stdin!.flush()
		const secondTabDeadline = Date.now() + 2000
		while (Date.now() < secondTabDeadline) {
			if (readSessionIds().length === 2) break
			await Bun.sleep(50)
		}

		const beforeFork = readSessionIds()
		expect(beforeFork).toHaveLength(2)
		const parentId = beforeFork[0]!
		const rightTabId = beforeFork[1]!

		const commandPath = join(tmpDir, "ipc", "commands.asonl")
		const forkCommand = ason.stringify({ type: 'open', text: `fork:${parentId}`, sessionId: parentId, createdAt: new Date().toISOString() }, 'short')
		Bun.write(commandPath, `${readFileSync(commandPath, 'utf-8')}${forkCommand}\n`)

		const forkDeadline = Date.now() + 2000
		while (Date.now() < forkDeadline) {
			if (readSessionIds().length === 3) break
			await Bun.sleep(50)
		}

		const afterFork = readSessionIds()
		expect(afterFork).toHaveLength(3)
		expect(afterFork[0]).toBe(parentId)
		expect(afterFork[2]).toBe(rightTabId)
		expect(afterFork[1]).not.toBe(parentId)
		expect(afterFork[1]).not.toBe(rightTabId)

		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		await proc.exited
	})


	test("open after inserts a plain new tab next to the target tab", async () => {
		const proc = spawnHal()
		await Bun.sleep(300)

		proc.stdin!.write(new Uint8Array([0x14])) // ctrl-t
		proc.stdin!.flush()
		const secondTabDeadline = Date.now() + 2000
		while (Date.now() < secondTabDeadline) {
			if (readSessionIds().length === 2) break
			await Bun.sleep(50)
		}

		const beforeOpen = readSessionIds()
		expect(beforeOpen).toHaveLength(2)
		const targetId = beforeOpen[0]!
		const rightTabId = beforeOpen[1]!

		const commandPath = join(tmpDir, "ipc", "commands.asonl")
		const openCommand = ason.stringify({ type: 'open', text: `after:${targetId}`, sessionId: targetId, createdAt: new Date().toISOString() }, 'short')
		Bun.write(commandPath, `${readFileSync(commandPath, 'utf-8')}${openCommand}\n`)

		const openDeadline = Date.now() + 2000
		while (Date.now() < openDeadline) {
			if (readSessionIds().length === 3) break
			await Bun.sleep(50)
		}

		const afterOpen = readSessionIds()
		expect(afterOpen).toHaveLength(3)
		expect(afterOpen[0]).toBe(targetId)
		expect(afterOpen[2]).toBe(rightTabId)
		expect(afterOpen[1]).not.toBe(targetId)
		expect(afterOpen[1]).not.toBe(rightTabId)

		proc.stdin!.write(new Uint8Array([0x03]))
		proc.stdin!.flush()
		await proc.exited
	})

})
