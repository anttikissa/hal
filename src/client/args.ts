// Command-line arguments (task cb): one pure parse, run first in
// main.start, so a mistyped option never starts Hal.

export type Args =
	| { kind: 'terminal' }
	| { kind: 'help' }
	| { kind: 'version' }
	| { kind: 'auth' }
	| { kind: 'remote'; host?: string }
	| { kind: 'print'; prompt: string; dir?: string; model?: string }
	| { kind: 'error'; message: string }

const usage = `Usage:
  hal                                    start the terminal client
  hal -p <prompt> [-d <dir>] [-m <model>] run one prompt in a new tab, print the reply
  hal -r [host]                          follow a remote Hal
  hal auth                               print a one-time web login code
  hal -v, --version                      show the version, commit and checkout
  hal -h, --help                         show this help
`

function parse(argv: string[]): Args {
	let [first, ...rest] = argv
	if (first === undefined) return { kind: 'terminal' }
	if (argv.length === 1 && ['-h', '--help', 'help'].includes(first)) return { kind: 'help' }
	if (argv.length === 1 && ['-v', '--version'].includes(first)) return { kind: 'version' }
	if (first === 'auth' && !rest.length) return { kind: 'auth' }
	if (first === '-r' && rest.length <= 1) return rest[0] === undefined ? { kind: 'remote' } : rest[0].startsWith('-') ? { kind: 'error', message: `-r: unexpected ${rest[0]}` } : { kind: 'remote', host: rest[0] }
	if (!argv.includes('-p') && !argv.includes('--print')) return { kind: 'error', message: `unknown arguments: ${argv.join(' ')}` }
	let opts: { prompt?: string; dir?: string; model?: string; print?: true } = {}
	let names: Record<string, 'dir' | 'model'> = { '-d': 'dir', '--dir': 'dir', '-m': 'model', '--model': 'model' }
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i]!
		let name = names[arg]
		if (arg === '-p' || arg === '--print') {
			if (opts.print) return { kind: 'error', message: `${arg} given twice` }
			opts.print = true
		} else if (name) {
			let value = argv[++i]
			if (value === undefined || value.startsWith('-')) return { kind: 'error', message: `${arg} needs a value` }
			if (opts[name] !== undefined) return { kind: 'error', message: `${arg} given twice` }
			opts[name] = value
		} else if (arg.startsWith('-') && arg !== '-') return { kind: 'error', message: `unknown option ${arg}` }
		else if (opts.prompt !== undefined) return { kind: 'error', message: `one prompt only; quote it (unexpected ${arg})` }
		else opts.prompt = arg
	}
	if (!opts.prompt?.trim()) return { kind: 'error', message: '-p needs a prompt' }
	return { kind: 'print', prompt: opts.prompt, ...(opts.dir !== undefined && { dir: opts.dir }), ...(opts.model !== undefined && { model: opts.model }) }
}

export const args = { usage: () => usage, parse }
