import { test, expect } from 'bun:test'
import { resolve } from 'path'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'

function spawnHarness(stateDir: string) {
	const halDir = resolve(import.meta.dir, '../..')
	const proc = Bun.spawn(['bun', 'src/test-harness.ts'], {
		cwd: halDir,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'inherit',
		env: { ...process.env, HAL_DIR: halDir, HAL_STATE_DIR: stateDir },
	})

	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	const records: any[] = []

	async function readUntil(match: (r: any) => boolean, timeoutMs = 10000): Promise<any> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const found = records.find(match)
			if (found) return found
			const remaining = deadline - Date.now()
			if (remaining <= 0) break
			const result = await Promise.race([
				reader.read(),
				Bun.sleep(remaining).then(() => null),
			])
			if (!result || result.done) break
			buffer += decoder.decode(result.value, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop()!
			for (const line of lines) {
				if (!line.trim()) continue
				try { records.push(JSON.parse(line)) } catch {}
			}
		}
		const found = records.find(match)
		if (found) return found
		throw new Error(`Timed out waiting. Records: ${JSON.stringify(records, null, 2)}`)
	}

	function type(text: string) { proc.stdin.write(text) }
	function enter() { proc.stdin.write('\r') }

	async function cleanup() {
		try { proc.stdin.end() } catch {}
		await proc.exited
		try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
	}

	return { proc, readUntil, type, enter, cleanup, records }
}

test('/fork creates a new session with parent history', async () => {
	const stateDir = mkdtempSync(resolve(tmpdir(), 'hal-fork-'))

	const h = spawnHarness(stateDir)
	try {
		await h.readUntil(r => r.type === 'ready')

		// Get the initial session ID
		const sessionsEvent = await h.readUntil(r => r.type === 'sessions')
		const parentId = sessionsEvent.activeSessionId
		expect(parentId).toBeTruthy()

		// Type /fork and submit
		h.type('/fork')
		await Bun.sleep(50)
		h.enter()

		// Wait for the fork info line
		const forkInfo = await h.readUntil(r =>
			r.type === 'line' && r.level === 'meta' && r.text.includes('[fork]')
		)
		expect(forkInfo.text).toContain(parentId)

		// Wait for sessions event showing the new active session
		const newSessions = await h.readUntil(r =>
			r.type === 'sessions' && r.activeSessionId !== parentId
		)
		const childId = newSessions.activeSessionId
		expect(childId).toBeTruthy()
		expect(childId).not.toBe(parentId)
		expect(newSessions.sessions).toContain(childId)
		expect(newSessions.sessions).toContain(parentId)

		// Verify the child session's history.asonl has forked_from
		const childDir = resolve(stateDir, 'sessions', childId)
		const childLog = readFileSync(resolve(childDir, 'history.asonl'), 'utf-8')
		expect(childLog).toContain('forked_from')
		expect(childLog).toContain(parentId)
		expect(childLog).toContain('[system]')
	} finally {
		await h.cleanup()
	}
}, 15000)

test('/reset rotates the log file', async () => {
	const stateDir = mkdtempSync(resolve(tmpdir(), 'hal-reset-'))

	const h = spawnHarness(stateDir)
	try {
		await h.readUntil(r => r.type === 'ready')

		const sessionsEvent = await h.readUntil(r => r.type === 'sessions')
		const sessionId = sessionsEvent.activeSessionId

		// Type /reset and submit
		h.type('/reset')
		await Bun.sleep(50)
		h.enter()

		// Wait for reset info line
		await h.readUntil(r =>
			r.type === 'line' && r.text.includes('[reset]')
		)
		await Bun.sleep(200)

		// Verify the session dir has both history.asonl and history2.asonl
		const sessionDir = resolve(stateDir, 'sessions', sessionId)
		const files = readdirSync(sessionDir)
		expect(files).toContain('history.asonl')
		expect(files).toContain('history2.asonl')

		// The new log should have the [system] breadcrumb
		const newLog = readFileSync(resolve(sessionDir, 'history2.asonl'), 'utf-8')
		expect(newLog).toContain('[system]')
		expect(newLog).toContain('history.asonl')
	} finally {
		await h.cleanup()
	}
}, 15000)
