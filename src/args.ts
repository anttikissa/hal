import { mkdirSync, mkdtempSync } from 'fs'
import { join } from 'path'

const rawArgs = process.argv.slice(2)
const argv = new Set(rawArgs)
const has = (...flags: string[]) => flags.some((f) => argv.has(f))

const HELP_TEXT = `Usage: bun main.ts [flags]

Flags:
  -f, --fresh      Start with a fresh temp state directory
      --headless   Run without the TUI (owner mode only)
      --test       Test mode: structured ASON output, no TUI
  -h, --help       Show this help`

if (has('-h', '--help')) {
	console.log(HELP_TEXT)
	process.exit(0)
}

const knownFlags = new Set(['-f', '--fresh', '--headless', '--test', '-h', '--help'])
const unknownFlags = rawArgs.filter((arg) => arg.startsWith('-') && !knownFlags.has(arg))
if (unknownFlags.length > 0) {
	console.error(`[args] Unknown flag(s): ${unknownFlags.join(', ')}`)
	console.error(HELP_TEXT)
	process.exit(1)
}

export const headless = has('--headless')
export const testMode = has('--test')

export const fresh = has('-f', '--fresh') || testMode
if (fresh && !process.env.HAL_STATE_DIR?.startsWith('/tmp/hal/state/')) {
	// Only create a new temp dir if the run script hasn't already set one
	const base = '/tmp/hal/state'
	mkdirSync(base, { recursive: true })
	const dir = mkdtempSync(join(base, '/'))
	process.env.HAL_STATE_DIR = dir
}
