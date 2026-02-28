const rawArgs = process.argv.slice(2)
const argv = new Set(rawArgs)
const has = (...flags: string[]) => flags.some((f) => argv.has(f))

const HELP_TEXT = `Usage: hal [flags]

Flags:
  -s, --self       Self mode: cwd=hal_dir, find idle low-context session or open new tab
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
export const selfMode = process.env.HAL_SELF_MODE === '1'

// -f/--fresh: create a temp state dir. HAL_STATE_DIR takes precedence.
// When launched via ./run, -f is already handled (stripped + env set).
// This path covers standalone `bun main.ts -f` and --test.
export const fresh = has('-f', '--fresh') || testMode
if (fresh && !process.env.HAL_STATE_DIR) {
	const { makeFreshDir } = await import('./fresh-dir.ts')
	process.env.HAL_STATE_DIR = makeFreshDir()
}
