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
	test('pause during bash tool kills the subprocess', async () => {
		const pidFile = `/tmp/hal-test-sleep-${Date.now()}.pid`
		try { unlinkSync(pidFile) } catch {}

		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\]/)

		// "bash <cmd>" triggers mock provider to call bash tool with <cmd>
		hal.sendLine(`bash echo $$ > ${pidFile} && sleep 1000`)

		// Wait until tool is running
		await hal.waitFor(
			(r) => r.type === 'tool_progress' && r.tools?.some((t: any) => t.status === 'running'),
			5000,
		)

		// Wait for PID file
		for (let i = 0; i < 50; i++) {
			if (existsSync(pidFile)) break
			await Bun.sleep(50)
		}
		expect(existsSync(pidFile)).toBe(true)
		const pid = parseInt(await Bun.file(pidFile).text(), 10)
		expect(pid).toBeGreaterThan(0)

		const isAlive = () => { try { process.kill(pid, 0); return true } catch { return false } }
		expect(isAlive()).toBe(true)

		// Send pause command (same as Esc in TUI)
		const pauseCmd = makeCommand('pause', testSource, undefined, sessionId)
		await hal.sendCommand(pauseCmd)

		// Pause command should complete
		await hal.waitFor(
			(r) => r.type === 'command' && r.commandId === pauseCmd.id && r.phase === 'done',
			10000,
		)

		// The sleep subprocess should be dead
		for (let i = 0; i < 30; i++) {
			if (!isAlive()) break
			await Bun.sleep(100)
		}
		expect(isAlive()).toBe(false)

		try { unlinkSync(pidFile) } catch {}
	}, 20000)
})
