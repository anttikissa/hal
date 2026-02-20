import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const rawArgs = process.argv.slice(2)
const argv = new Set(rawArgs)
const has = (...flags: string[]) => flags.some(f => argv.has(f))

const HELP_TEXT = `Usage: bun main.ts [flags]

Flags:
  -f, --fresh      Start with a fresh temp state directory
      --headless   Run without the TUI (owner mode only)
  -h, --help       Show this help`

if (has("-h", "--help")) {
	console.log(HELP_TEXT)
	process.exit(0)
}

const knownFlags = new Set(["-f", "--fresh", "--headless", "-h", "--help"])
const unknownFlags = rawArgs.filter(arg => arg.startsWith("-") && !knownFlags.has(arg))
if (unknownFlags.length > 0) {
	console.error(`[args] Unknown flag(s): ${unknownFlags.join(", ")}`)
	console.error(HELP_TEXT)
	process.exit(1)
}

export const headless = has("--headless")

export const fresh = has("-f", "--fresh")
if (fresh) {
	const dir = mkdtempSync(join(tmpdir(), "hal-state-"))
	process.env.HAL_STATE_DIR = dir
}
