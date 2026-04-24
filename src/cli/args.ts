type ParseEnv = {
	cwd: string
	halDir: string
}

type ParseResult =
	| { ok: true; help: boolean; targetCwd: string }
	| { ok: false; error: string }

function helpText(): string {
	return [
		'Usage: hal [options]',
		'',
		'Options:',
		'  -s, --self       Open Hal in its own directory instead of the current directory.',
		'  -f, --fresh      Use a fresh isolated temporary state directory.',
		'  -h, -?, --help   Show this help and exit.',
		'',
		'No positional arguments are accepted yet.',
	].join('\n')
}

function parse(args: string[], env: ParseEnv): ParseResult {
	let self = false
	let help = false

	for (const arg of args) {
		if (arg === '-s' || arg === '--self') {
			self = true
			continue
		}
		if (arg === '-h' || arg === '-?' || arg === '--help') {
			help = true
			continue
		}
		// The shell wrapper consumes fresh-state options before main.ts starts.
		// Accept them here too so direct `bun src/main.ts --fresh` has the same
		// command-line surface as `./run --fresh`.
		if (arg === '-f' || arg === '--fresh') continue
		if (arg.startsWith('-')) return { ok: false, error: `Unknown option: ${arg}` }
		return { ok: false, error: `Unexpected argument: ${arg}` }
	}

	return { ok: true, help, targetCwd: self ? env.halDir : env.cwd }
}

export const cliArgs = {
	helpText,
	parse,
}
