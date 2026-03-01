import { resolve } from 'path'
import { appendFile } from 'fs/promises'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'

const SOURCE_DIR = resolve(import.meta.dir, '../../..')

export class TestHal {
	/** All records received so far */
	records: any[] = []

	private proc: ReturnType<typeof Bun.spawn>
	readonly halDir: string
	private cleanupOnStop: boolean
	private waiters: Array<{
		match: (r: any) => boolean
		resolve: (r: any) => void
		reject: (e: Error) => void
	}> = []

	constructor(proc: ReturnType<typeof Bun.spawn>, halDir: string, cleanupOnStop = true) {
		this.proc = proc
		this.halDir = halDir
		this.cleanupOnStop = cleanupOnStop

		// Read stdout lines in background, parse JSON, dispatch to waiters
		void (async () => {
			const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
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
		;(this.proc.stdin as any).write(text + '\n')
	}

	/** Send a raw command to the IPC bus (bypasses stdin/CLI parsing) */
	async sendCommand(command: any): Promise<void> {
		const { stringify } = await import('../../utils/ason.ts')
		const ipcDir = `${this.halDir}/state/ipc`
		const commandsFile = `${ipcDir}/commands.asonl`
		await appendFile(commandsFile, stringify(command, 'short') + '\n')
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

	/** Wait for a prompt event matching text pattern and optional label */
	waitForPrompt(pattern: string | RegExp, label?: string, timeoutMs = 5000): Promise<any> {
		const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern
		return this.waitFor(
			(r) =>
				r.type === 'prompt' &&
				re.test(r.text ?? '') &&
				(label === undefined || r.label === label),
			timeoutMs,
		)
	}

	/** Wait for the {type:'ready'} signal */
	async waitForReady(timeoutMs = 5000): Promise<void> {
		await this.waitFor((r) => r.type === 'ready', timeoutMs)
	}

	/** Stop the process and return exit code */
	async stop(options?: { keepDir?: boolean }): Promise<{ exitCode: number }> {
		try {
			;(this.proc.stdin as any).end()
		} catch {}
		const exitCode = await this.proc.exited
		// Clean up entire isolated hal dir (includes state)
		if (this.cleanupOnStop && !options?.keepDir) {
			try {
				rmSync(this.halDir, { recursive: true, force: true })
			} catch {}
		}
		return { exitCode }
	}
}

export interface StartHalOptions {
	env?: Record<string, string>
	config?: string
	setup?: (paths: { halDir: string; stateDir: string }) => Promise<void> | void
	halDir?: string
	cleanupOnStop?: boolean
}

export async function startHal(options?: StartHalOptions): Promise<TestHal> {
	// Fully isolated: both HAL_DIR and HAL_STATE_DIR point to a temp dir
	// so tests never read or write the real config, auth, or state files
	const halDir = options?.halDir ?? mkdtempSync(resolve(tmpdir(), 'hal-test-'))
	if (!existsSync(halDir)) mkdirSync(halDir, { recursive: true })
	const stateDir = `${halDir}/state`
	mkdirSync(stateDir, { recursive: true })

	// Seed minimal config so tests don't inherit the user's real config
	const configPath = `${halDir}/config.ason`
	if (options?.config !== undefined) {
		writeFileSync(configPath, options.config)
	} else if (!existsSync(configPath)) {
		writeFileSync(configPath, "{ model: 'anthropic/claude-opus-4-6' }\n")
	}
	if (options?.setup) await options.setup({ halDir, stateDir })

	const baseEnv: Record<string, string> = { ...process.env } as Record<string, string>
	if (options?.env) {
		for (const [k, v] of Object.entries(options.env)) baseEnv[k] = v
	}
	const randomPort = String(12000 + Math.floor(Math.random() * 40000))
	const mergedEnv = {
		...baseEnv,
		HAL_DIR: halDir,
		HAL_STATE_DIR: stateDir,
		HAL_WEB_PORT: baseEnv.HAL_WEB_PORT ?? randomPort,
	}
	const proc = Bun.spawn(['bun', 'main.ts', '--test'], {
		cwd: SOURCE_DIR,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'inherit',
		env: mergedEnv,
	})

	return new TestHal(proc, halDir, options?.cleanupOnStop ?? true)
}
