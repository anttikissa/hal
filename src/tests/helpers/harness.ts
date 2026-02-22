import { resolve } from 'path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'

const SOURCE_DIR = resolve(import.meta.dir, '../../..')

export class TestHal {
	/** All records received so far */
	records: any[] = []

	private proc: ReturnType<typeof Bun.spawn>
	private halDir: string
	private waiters: Array<{
		match: (r: any) => boolean
		resolve: (r: any) => void
		reject: (e: Error) => void
	}> = []

	constructor(proc: ReturnType<typeof Bun.spawn>, halDir: string) {
		this.proc = proc
		this.halDir = halDir

		// Read stdout lines in background, parse JSON, dispatch to waiters
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
					this.records.push(record)
					// Check waiters
					for (let i = this.waiters.length - 1; i >= 0; i--) {
						if (this.waiters[i].match(record)) {
							this.waiters[i].resolve(record)
							this.waiters.splice(i, 1)
						}
					}
				}
			}
		})()
	}

	/** Send a line to stdin (prompt or /command) */
	sendLine(text: string): void {
		this.proc.stdin.write(text + '\n')
	}

	/** Wait for a record matching the predicate */
	waitFor(match: (record: any) => boolean, timeoutMs = 5000): Promise<any> {
		// Check already-received records first
		const existing = this.records.find(match)
		if (existing) return Promise.resolve(existing)

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.findIndex((w) => w.resolve === resolve)
				if (idx >= 0) this.waiters.splice(idx, 1)
				reject(
					new Error(
						`waitFor timed out after ${timeoutMs}ms. Records received: ${this.records.length}`,
					),
				)
			}, timeoutMs)

			this.waiters.push({
				match,
				resolve: (r) => {
					clearTimeout(timer)
					resolve(r)
				},
				reject,
			})
		})
	}

	/** Wait for a line event whose text matches the pattern */
	waitForLine(pattern: string | RegExp, timeoutMs = 5000): Promise<any> {
		const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern
		return this.waitFor((r) => r.type === 'line' && re.test(r.text ?? ''), timeoutMs)
	}

	/** Wait for the {type:'ready'} signal */
	async waitForReady(timeoutMs = 5000): Promise<void> {
		await this.waitFor((r) => r.type === 'ready', timeoutMs)
	}

	/** Stop the process and return exit code */
	async stop(): Promise<{ exitCode: number }> {
		try {
			this.proc.stdin.end()
		} catch {}
		const exitCode = await this.proc.exited
		// Clean up entire isolated hal dir (includes state)
		try {
			rmSync(this.halDir, { recursive: true, force: true })
		} catch {}
		return { exitCode }
	}
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

	return new TestHal(proc, halDir)
}
