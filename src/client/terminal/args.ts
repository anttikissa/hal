type ParseEnv = {
	cwd: string
	halDir: string
}

type ParseResult =
	| { ok: true; help: boolean; targetCwd: string; stateDir?: string; webPort?: number; remoteUrl?: string }
	| { ok: false; error: string }

function helpText(): string {
	return [
		'Usage: hal [options]',
		'',
		'Options:',
		'  -s, --self       Open Hal in its own directory instead of the current directory.',
		'  -f, --fresh      Use a fresh isolated temporary state directory.',
		'  -r <url>         Connect this terminal to a HAL web server.',
		'  -h, -?, --help   Show this help and exit.',
		'      --state-dir <dir>  Use an existing state directory (or create it).',
		'      --web[=<port>]    Serve the local web client (default port: 9001).',
		'',
		'No positional arguments are accepted yet.',
	].join('\n')
}

function parse(args: string[], env: ParseEnv): ParseResult {
	let self = false
	let help = false
	let stateDir: string | undefined
	let webPort: number | undefined
	let remoteUrl: string | undefined
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!
		if (arg === '-s' || arg === '--self') {
			self = true
			continue
		}
		if (arg === '-h' || arg === '-?' || arg === '--help') {
			help = true
			continue
		}
		if (arg === '-r') {
			remoteUrl = args[++i]
			if (!remoteUrl) return { ok: false, error: '-r requires a remote URL' }
			continue
		}
		if (arg === '--state-dir') {
			stateDir = args[++i]
			if (!stateDir) return { ok: false, error: '--state-dir requires a directory' }
			continue
		}
		if (arg.startsWith('--state-dir=')) {
			stateDir = arg.slice('--state-dir='.length)
			if (!stateDir) return { ok: false, error: '--state-dir requires a directory' }
			continue
		}
		if (arg === '--web' || arg.startsWith('--web=')) {
			const value = arg === '--web' ? '9001' : arg.slice('--web='.length)
			webPort = Number(value)
			if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) return { ok: false, error: '--web port must be a number from 1 to 65535' }
			continue
		}
		// The shell wrapper consumes fresh-state options before main.ts starts.
		// Accept them here too so direct `bun src/main.ts --fresh` has the same
		// command-line surface as `./run --fresh`.
		if (arg === '-f' || arg === '--fresh') continue
		if (arg.startsWith('-')) return { ok: false, error: `Unknown option: ${arg}` }
		return { ok: false, error: `Unexpected argument: ${arg}` }
	}

	const result: { ok: true; help: boolean; targetCwd: string; stateDir?: string; webPort?: number; remoteUrl?: string } = { ok: true, help, targetCwd: self ? env.halDir : env.cwd }
	if (stateDir) result.stateDir = stateDir
	if (webPort) result.webPort = webPort
	if (remoteUrl) result.remoteUrl = remoteUrl
	return result
}

export const cliArgs = {
	helpText,
	parse,
}
