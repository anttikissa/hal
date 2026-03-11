import { test, expect } from 'bun:test'
import { bash } from './bash.ts'
import { existsSync, unlinkSync } from 'fs'

test('formatBlock keeps short command inline', () => {
	const view = bash.formatBlock({
		command: 'echo hello',
		status: 'done',
		elapsed: '1.0s',
		output: 'hello\n',
		commandWidth: 40,
		maxOutputLines: 5,
	})
	expect(view.label).toBe('bash: echo hello (1.0s) ✓')
	expect(view.commandLines).toEqual([])
	expect(view.outputLines).toEqual(['hello'])
	expect(view.hiddenOutputLines).toBe(0)
})

test('formatBlock moves long command below header with continuation', () => {
	const view = bash.formatBlock({
		command: 'echo ' + 'x'.repeat(80),
		status: 'running',
		elapsed: '0.4s',
		output: '',
		commandWidth: 24,
		maxOutputLines: 5,
	})
	expect(view.label).toBe('bash: (0.4s) …')
	expect(view.commandLines.length).toBeGreaterThan(1)
	expect(view.commandLines[0]).toEndWith(' \\')
	expect(view.hiddenOutputLines).toBe(0)
})

test('formatBlock truncates output from the head', () => {
	const output = Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join('\n')
	const view = bash.formatBlock({
		command: 'echo many',
		status: 'done',
		elapsed: '2.0s',
		output,
		commandWidth: 30,
		maxOutputLines: 3,
	})
	expect(view.hiddenOutputLines).toBe(4)
	expect(view.outputLines).toEqual(['line 5', 'line 6', 'line 7'])
})

test('abort kills child process tree', async () => {
	const pidFile = `/tmp/hal-bash-kill-test-${Date.now()}.pid`
	try { unlinkSync(pidFile) } catch {}

	const controller = new AbortController()
	const promise = bash.execute(
		{ command: `sh -c 'echo $$ > ${pidFile} && sleep 1000'` },
		{ cwd: '/tmp', signal: controller.signal },
	)

	// Wait for child PID file
	for (let i = 0; i < 100; i++) {
		if (existsSync(pidFile)) break
		await Bun.sleep(50)
	}
	expect(existsSync(pidFile)).toBe(true)
	const childPid = parseInt(await Bun.file(pidFile).text(), 10)
	expect(childPid).toBeGreaterThan(0)

	const isAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
	expect(isAlive(childPid)).toBe(true)

	controller.abort()
	const result = await promise
	expect(result).toContain('[interrupted]')

	// Child should be dead
	for (let i = 0; i < 30; i++) {
		if (!isAlive(childPid)) break
		await Bun.sleep(100)
	}
	expect(isAlive(childPid)).toBe(false)

	try { unlinkSync(pidFile) } catch {}
}, 10000)
