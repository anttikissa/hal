/**
 * Replay a debug/bug log into a fresh state directory.
 *
 * Usage: bun src/debug-replay.ts <bug-log.asonl> [--dir <output-dir>]
 *
 * Reads the log, extracts initial state (config + files), and writes them
 * to a fresh directory. Also prints a summary of keypresses and events.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import { parseAll } from './utils/ason.ts'

async function main() {
	const args = process.argv.slice(2)
	if (args.length === 0) {
		console.log('Usage: bun src/debug-replay.ts <bug-log.asonl> [--dir <output-dir>]')
		process.exit(1)
	}

	const logFile = args[0]
	const dirIdx = args.indexOf('--dir')
	const outDir =
		dirIdx >= 0 && args[dirIdx + 1]
			? resolve(args[dirIdx + 1])
			: resolve(`/tmp/hal-replay-${Date.now()}`)

	console.log(`Reading ${logFile}...`)
	const raw = await readFile(logFile, 'utf-8')
	const records = parseAll(raw)
	console.log(`${records.length} records found`)

	// Categorize
	const configs: any[] = []
	const files: any[] = []
	const keypresses: any[] = []
	const snapshots: any[] = []
	const bugs: any[] = []

	for (const r of records) {
		switch (r.type) {
			case 'config':
				configs.push(r)
				break
			case 'file':
				files.push(r)
				break
			case 'keypress':
				keypresses.push(r)
				break
			case 'snapshot':
				snapshots.push(r)
				break
			case 'bug':
				bugs.push(r)
				break
		}
	}

	console.log(
		`  ${configs.length} config, ${files.length} files, ${keypresses.length} keypresses, ${snapshots.length} snapshots, ${bugs.length} bugs`,
	)

	// Restore state
	await mkdir(outDir, { recursive: true })

	// Write config
	if (configs.length > 0) {
		const configPath = resolve(outDir, 'config.ason')
		await writeFile(configPath, configs[0].content)
		console.log(`  wrote config.ason`)
	}

	// Write state files
	for (const f of files) {
		const filePath = resolve(outDir, f.name)
		await mkdir(dirname(filePath), { recursive: true })
		await writeFile(filePath, f.content)
	}
	if (files.length > 0) console.log(`  wrote ${files.length} state files`)

	// Print keypress timeline
	if (keypresses.length > 0) {
		const first = keypresses[0].t
		const last = keypresses[keypresses.length - 1].t
		const duration = ((last - first) / 1000).toFixed(1)

		// Reconstruct typed text from keypresses
		const typed: string[] = []
		for (const k of keypresses) {
			if (k.key === '\r') typed.push('⏎')
			else if (k.key === '\x1b') typed.push('⎋')
			else if (k.key.startsWith('['))
				continue // focus/escape sequences
			else typed.push(k.key)
		}
		console.log(`\n  Keypresses (${duration}s, ${keypresses.length} keys):`)
		console.log(`  ${typed.join('')}`)
	}

	// Print bug descriptions
	for (const b of bugs) {
		console.log(`\n  Bug: ${b.description}`)
	}

	// Print last snapshot excerpt
	if (snapshots.length > 0) {
		const last = snapshots[snapshots.length - 1]
		const lines = last.terminal.split('\n')
		const tail = lines.slice(-20).join('\n')
		console.log(`\n  Last snapshot (${lines.length} lines, showing last 20):`)
		console.log(tail)
	}

	console.log(`\nState restored to: ${outDir}`)
	console.log(`  To use: HAL_STATE_DIR=${outDir}/state HAL_DIR=${outDir} bun main.ts`)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
