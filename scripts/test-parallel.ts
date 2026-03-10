#!/usr/bin/env bun
/**
 * Runs all test files in parallel as separate processes.
 */
import { resolve } from 'path'

const ROOT = resolve(import.meta.dirname, '..')
const TIMEOUT_MS = 30_000
const SLOWEST_LIMIT = 10

export type FileTiming = {
	file: string
	elapsedMs: number
}

type Summary = {
	totalPass: number
	totalFail: number
	failedFiles: number
	elapsedMs: number
}

function listTestFiles(root: string): string[] {
	const glob = new Bun.Glob('src/**/*.test.ts')
	return [...glob.scanSync(root)].filter(f => !f.endsWith('failing.test.ts')).sort()
}

export function formatMs(ms: number): string {
	return `${Math.round(ms)}ms`
}

export function pickSlowest(timings: FileTiming[], limit = SLOWEST_LIMIT): FileTiming[] {
	return [...timings].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, limit)
}

export function buildSummaryLine(summary: Summary): string {
	const status = summary.failedFiles ? `${summary.failedFiles} file(s) failed` : 'all passed'
	return `\n${summary.totalPass} pass, ${summary.totalFail} fail — ${status} in ${formatMs(summary.elapsedMs)}`
}

async function run(): Promise<number> {
	const files = listTestFiles(ROOT)
	const t0 = performance.now()
	const procs = files.map(file => ({
		file,
		startedAt: performance.now(),
		proc: Bun.spawn(['bun', 'test', file], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }),
	}))

	let failedFiles = 0
	let totalPass = 0
	let totalFail = 0
	const timings: FileTiming[] = []

	for (const { file, startedAt, proc } of procs) {
		const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS)
		const code = await proc.exited
		clearTimeout(timeout)

		const elapsedMs = performance.now() - startedAt
		timings.push({ file, elapsedMs })

		const timedOut = proc.signalCode !== null
		const stdout = await new Response(proc.stdout).text()
		const stderr = await new Response(proc.stderr).text()
		const all = stdout + stderr

		const passMatch = all.match(/(\d+) pass/)
		const failMatch = all.match(/(\d+) fail\b/)
		if (passMatch) totalPass += parseInt(passMatch[1])
		if (failMatch) totalFail += parseInt(failMatch[1])

		if (timedOut) {
			console.log(`⏰ ${file} (${formatMs(elapsedMs)})  (killed after ${TIMEOUT_MS / 1000}s)`)
			process.stdout.write(stdout)
			process.stderr.write(stderr)
			failedFiles++
			continue
		}

		if (code !== 0) {
			console.log(`❌ ${file} (${formatMs(elapsedMs)})`)
			process.stdout.write(stdout)
			process.stderr.write(stderr)
			failedFiles++
			continue
		}

		const summary = stdout.match(/(\d+ pass.*)/m)
		console.log(`✅ ${file} (${formatMs(elapsedMs)})${summary ? `  (${summary[1].trim()})` : ''}`)
	}

	const elapsedMs = performance.now() - t0
	console.log(
		buildSummaryLine({
			totalPass,
			totalFail,
			failedFiles,
			elapsedMs,
		}),
	)

	const slowest = pickSlowest(timings)
	if (slowest.length > 0) {
		console.log('slowest files:')
		for (const item of slowest) {
			console.log(`  ${formatMs(item.elapsedMs)}  ${item.file}`)
		}
	}

	return failedFiles ? 1 : 0
}

if (import.meta.main) {
	process.exit(await run())
}
