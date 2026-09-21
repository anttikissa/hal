type ParseEnv = {
	cwd: string
	halDir: string
}

type ParseResult =
	| { ok: true; help: boolean; targetCwd: string; stateDir?: string; remoteHost?: string | null; auth?: true }
	| { ok: false; error: string }

function helpText(): string {
	return [
		'Usage: hal [options]',
		'       hal auth',
		'',
		'Options:',
		'  -s, --self       Open Hal in its own directory instead of the current directory.',
		'  -f, --fresh      Use a fresh isolated temporary state directory.',
		'  -r [host]        Connect to a HAL host over HTTPS; reuse the last host when omitted.',
		'  -h, -?, --help   Show this help and exit.',
		'      --state-dir <dir>  Use an existing state directory (or create it).',
		'',
		'Commands:',
		'  auth             Print this host’s authentication token for remote HAL clients.',
	].join('\n')
}

function parse(args: string[], env: ParseEnv): ParseResult {
	if (args.length === 1 && args[0] === 'auth') return { ok: true, help: false, targetCwd: env.cwd, auth: true }
	let self = false
	let help = false
	let stateDir: string | undefined
	let remoteHost: string | null | undefined
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
			remoteHost = null
			if (args[i + 1] && !args[i + 1]!.startsWith('-')) remoteHost = args[++i]!
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
		// The shell wrapper consumes fresh-state options before main.ts starts.
		// Accept them here too so direct `bun src/main.ts --fresh` has the same
		// command-line surface as `./run --fresh`.
		if (arg === '-f' || arg === '--fresh') continue
		if (arg.startsWith('-')) return { ok: false, error: `Unknown option: ${arg}` }
		return { ok: false, error: `Unexpected argument: ${arg}` }
	}

	const result: { ok: true; help: boolean; targetCwd: string; stateDir?: string; remoteHost?: string | null } = { ok: true, help, targetCwd: self ? env.halDir : env.cwd }
	if (stateDir) result.stateDir = stateDir
	if (remoteHost !== undefined) result.remoteHost = remoteHost
	return result
}

export const cliArgs = {
	helpText,
	parse,
}
