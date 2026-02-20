import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const argv = new Set(process.argv.slice(2))
const has = (...flags: string[]) => flags.some(f => argv.has(f))

if (has("-h", "--help")) {
	console.log(`Usage: bun main.ts [flags]

Flags:
  -f, --fresh      Start with a fresh temp state directory
      --headless   Run without the TUI (owner mode only)
  -h, --help       Show this help`)
	process.exit(0)
}

export const headless = has("--headless")

export const fresh = has("-f", "--fresh")
if (fresh) {
	const dir = mkdtempSync(join(tmpdir(), "hal-state-"))
	process.env.HAL_STATE_DIR = dir
}
