import { describe, test, expect, afterEach } from 'bun:test'
import { startHal, type TestHal } from './helpers/harness.ts'
import { makeCommand } from '../protocol.ts'
import { existsSync, unlinkSync } from 'fs'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

const testSource = { kind: 'cli' as const, clientId: 'test-pause-tool' }

async function activeSessionId(h: TestHal): Promise<string> {
	const event = await h.waitFor(
		(r) => r.type === 'sessions' && typeof r.active === 'string' && r.sessions?.length >= 1,
	)
	return event.active as string
}

describe('pause kills running tool subprocess', () => {
	// Compound commands make bash fork a child process. Killing only
	// the top bash leaves the child alive with stdout open, so the
	// tool runner hangs in reader.read() forever.
	test('pause kills child process tree, not just top bash', async () => {
		const pidFile = `/tmp/hal-test-child-${Date.now()}.pid`
		try { unlinkSync(pidFile) } catch {}

		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\]/)

		// Use sh -c to create a child process with its own PID.
		// The child writes its PID then sleeps. Killing only the
		// outer bash won't kill this child.
		const cmd = `sh -c 'echo $$ > ${pidFile} && sleep 1000'`
		hal.sendLine(`bash ${cmd}`)

		// Wait until tool is running
		await hal.waitFor(
			(r) => r.type === 'tool_progress' && r.tools?.some((t: any) => t.status === 'running'),
			5000,
		)

		// Wait for child PID file
		for (let i = 0; i < 50; i++) {
			if (existsSync(pidFile)) break
			await Bun.sleep(50)
		}
		expect(existsSync(pidFile)).toBe(true)
		const childPid = parseInt(await Bun.file(pidFile).text(), 10)
		expect(childPid).toBeGreaterThan(0)

		const isAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
		expect(isAlive(childPid)).toBe(true)

		// Record position — only look at new status events after pause
		const recordsBefore = hal.records.length

		// Send pause command (same as Esc in TUI)
		const pauseCmd = makeCommand('pause', testSource, undefined, sessionId)
		await hal.sendCommand(pauseCmd)

		// Session should become idle (tool must finish, not hang on stdout)
		await hal.waitFor(
			(r) => {
				const idx = hal!.records.indexOf(r)
				if (idx < recordsBefore) return false
				return r.type === 'status' &&
					Array.isArray(r.busySessions) &&
					!r.busySessions.includes(sessionId)
			},
			10000,
		)

		// The child subprocess should also be dead
		for (let i = 0; i < 30; i++) {
			if (!isAlive(childPid)) break
			await Bun.sleep(100)
		}
		expect(isAlive(childPid)).toBe(false)

		try { unlinkSync(pidFile) } catch {}
	}, 20000)
})
