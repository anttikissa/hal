import { resolve } from 'path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'

const SOURCE_DIR = resolve(import.meta.dir, '../../..')

export interface TestHal {
	/** Send a line to stdin (prompt or /command) */
	sendLine(text: string): void
	/** Wait for a record matching the predicate */
	waitFor(match: (record: any) => boolean, timeoutMs?: number): Promise<any>
	/** Wait for a line event whose text matches the pattern */
	waitForLine(pattern: string | RegExp, timeoutMs?: number): Promise<any>
	/** Wait for the {type:'ready'} signal */
	waitForReady(timeoutMs?: number): Promise<void>
	/** Stop the process and return exit code */
	stop(): Promise<{ exitCode: number }>
	/** All records received so far */
	records: any[]
}

export async function startHal(options?: { env?: Record<string, string> }): Promise<TestHal> {
	// Fully isolated: both HAL_DIR and HAL_STATE_DIR point to a temp dir
	// so tests never read or write the real config, auth, or state files
	const halDir = mkdtempSync(resolve(tmpdir(), 'hal-test-'))
	const stateDir = `${halDir}/state`
	mkdirSync(stateDir, { recursive: true })

	// Seed minimal config so tests don't inherit the user's real config
	writeFileSync(`${halDir}/config.ason`, "{ model: 'anthropic/claude-opus-4-6' }\n")

	const proc = Bun.spawn(['bun', 'main.ts', '--test'], {
		cwd: SOURCE_DIR,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'inherit',
		env: { ...process.env, HAL_DIR: halDir, HAL_STATE_DIR: stateDir, ...options?.env },
	})

	const records: any[] = []
	const waiters: Array<{
		match: (r: any) => boolean
		resolve: (r: any) => void
		reject: (e: Error) => void
	}> = []

	// Read stdout lines in background, parse ASON, dispatch to waiters
	void (async () => {
		const reader = proc.stdout.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop()! // keep incomplete last line
			for (const line of lines) {
				if (!line.trim()) continue
				let record: any
				try {
					record = JSON.parse(line)
				} catch {
					continue
				}
				records.push(record)
				// Check waiters
				for (let i = waiters.length - 1; i >= 0; i--) {
					if (waiters[i].match(record)) {
						waiters[i].resolve(record)
						waiters.splice(i, 1)
					}
				}
			}
		}
	})()

	function sendLine(text: string): void {
		proc.stdin.write(text + '\n')
	}

	function waitFor(match: (r: any) => boolean, timeoutMs = 5000): Promise<any> {
		// Check already-received records first
		const existing = records.find(match)
		if (existing) return Promise.resolve(existing)

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = waiters.findIndex((w) => w.resolve === resolve)
				if (idx >= 0) waiters.splice(idx, 1)
				reject(
					new Error(
						`waitFor timed out after ${timeoutMs}ms. Records received: ${records.length}`,
					),
				)
			}, timeoutMs)

			waiters.push({
				match,
				resolve: (r) => {
					clearTimeout(timer)
					resolve(r)
				},
				reject,
			})
		})
	}

	function waitForLine(pattern: string | RegExp, timeoutMs = 5000): Promise<any> {
		const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern
		return waitFor((r) => r.type === 'line' && re.test(r.text ?? ''), timeoutMs)
	}

	async function waitForReady(timeoutMs = 5000): Promise<void> {
		await waitFor((r) => r.type === 'ready', timeoutMs)
	}

	async function stop(): Promise<{ exitCode: number }> {
		try {
			proc.stdin.end()
		} catch {}
		const exitCode = await proc.exited
		// Clean up entire isolated hal dir (includes state)
		try {
			rmSync(halDir, { recursive: true, force: true })
		} catch {}
		return { exitCode }
	}

	return { sendLine, waitFor, waitForLine, waitForReady, stop, records }
}
