#!/usr/bin/env bun
/**
 * Runs all test files in parallel as separate processes.
 */
import { resolve } from 'path'

const root = resolve(import.meta.dirname, '..')
const glob = new Bun.Glob('src/**/*.test.ts')
const files = [...glob.scanSync(root)].filter(f => !f.endsWith('failing.test.ts')).sort()

const TIMEOUT_MS = 30_000

const t0 = performance.now()
const procs = files.map(f => ({
	file: f,
	proc: Bun.spawn(['bun', 'test', f], { cwd: root, stdout: 'pipe', stderr: 'pipe' }),
}))

let failed = 0
let totalPass = 0
let totalFail = 0
for (const { file, proc } of procs) {
	const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS)
	const code = await proc.exited
	clearTimeout(timeout)
	const timedOut = proc.signalCode !== null
	const stdout = await new Response(proc.stdout).text()
	const stderr = await new Response(proc.stderr).text()
	const all = stdout + stderr
	const passMatch = all.match(/(\d+) pass/)
	const failMatch = all.match(/(\d+) fail\b/)
	if (passMatch) totalPass += parseInt(passMatch[1])
	if (failMatch) totalFail += parseInt(failMatch[1])
	if (timedOut) {
		console.log(`⏰ ${file}  (killed after ${TIMEOUT_MS / 1000}s)`)
		process.stdout.write(stdout)
		process.stderr.write(stderr)
		failed++
	} else if (code !== 0) {
		console.log(`❌ ${file}`)
		process.stdout.write(stdout)
		process.stderr.write(stderr)
		failed++
	} else {
		const summary = stdout.match(/(\d+ pass.*)/m)
		console.log(`✅ ${file}${summary ? `  (${summary[1].trim()})` : ''}`)
	}
}

const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
console.log(`\n${totalPass} pass, ${totalFail} fail — ${failed ? `${failed} file(s) failed` : 'all passed'} in ${elapsed}s`)
process.exit(failed ? 1 : 0)
