#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dirname, '..')
const TIMEOUT_MS = 30_000

// These files fail intermittently under Bun/macOS today. Most of the observed
// flakes came from fs.watch timing, process startup races, or both. Keep them
// out of the default suite so ./test stays signal-rich while we fix them.
export const FLAKY_TEST_FILES = new Set([
	'src/utils/tail-file.test.ts',
	'tests/ipc.test.ts',
	'tests/tabs.test.ts',
])

export interface TestListOptions {
	filter?: string
	flakyOnly?: boolean
}

export interface CliOptions extends TestListOptions {}

export function parseArgs(args: string[]): CliOptions {
	let filter: string | undefined
	let flakyOnly = false

	for (const arg of args) {
		if (arg === '--flaky') {
			flakyOnly = true
			continue
		}
		if (!filter) filter = arg
	}

	return { filter, flakyOnly }
}

export function listTestFiles(opts: TestListOptions = {}): string[] {
	const glob = new Bun.Glob('**/*.test.ts')
	return [...glob.scanSync(ROOT)]
		.filter((f) => !f.includes('node_modules'))
		.filter((f) => !f.includes('examples'))
		.filter((f) => !f.includes('previous'))
		.filter((f) => !f.endsWith('0-failing.test.ts'))
		.filter((f) => (opts.flakyOnly ? FLAKY_TEST_FILES.has(f) : !FLAKY_TEST_FILES.has(f)))
		.filter((f) => !opts.filter || f.includes(opts.filter))
		.sort()
}

export function isolatedTestEnv(stateDir: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HAL_STATE_DIR: stateDir,
	}
}

async function run(): Promise<number> {
	const opts = parseArgs(process.argv.slice(2))
	const files = listTestFiles(opts)
	const t0 = performance.now()

	let totalPass = 0
	let totalFail = 0
	const failedFiles: string[] = []

	const tasks = files.map(async (file) => {
		// Each test file gets its own isolated state dir. Many tests import src/state.ts
		// directly, which captures HAL_STATE_DIR at module load time. If we don't set
		// this before spawning bun test, in-process tests can write to the developer's
		// real ~/.hal/state and leak commands into the live runtime.
		const stateDir = mkdtempSync(join(tmpdir(), 'hal-test-state-'))
		const proc = Bun.spawn(['bun', 'test', `./${file}`], {
			cwd: ROOT,
			stdout: 'pipe',
			stderr: 'pipe',
			env: isolatedTestEnv(stateDir),
		})
		const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS)
		const code = await proc.exited
		clearTimeout(timeout)

		const stdout = await new Response(proc.stdout).text()
		const stderr = await new Response(proc.stderr).text()
		const all = stdout + stderr
		rmSync(stateDir, { recursive: true, force: true })

		const passMatch = all.match(/(\d+) pass/)
		const failMatch = all.match(/(\d+) fail\b/)
		if (passMatch) totalPass += parseInt(passMatch[1]!)
		if (failMatch) totalFail += parseInt(failMatch[1]!)

		if (proc.signalCode !== null) {
			console.log(`⏰ ${file} (killed after ${TIMEOUT_MS / 1000}s)`)
			process.stdout.write(stdout)
			process.stderr.write(stderr)
			failedFiles.push(file)
		} else if (code !== 0) {
			console.log(`❌ ${file}`)
			process.stdout.write(stdout)
			process.stderr.write(stderr)
			failedFiles.push(file)
		} else {
			const elapsed = all.match(/\[(\d+\.?\d*ms)\]/)
			console.log(`✅ ${file} ${elapsed ? elapsed[1] : ''}`)
		}
	})

	await Promise.all(tasks)

	const elapsed = Math.round(performance.now() - t0)
	console.log(`\n${totalPass} pass, ${totalFail} fail (${elapsed}ms)`)

	if (failedFiles.length) {
		console.log('\nfailed:')
		for (const f of failedFiles) console.log(`  ${f}`)
	}

	return failedFiles.length ? 1 : 0
}

if (import.meta.main) process.exit(await run())
