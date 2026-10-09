// Command-line arguments (task cb): one pure parse, run first in
// main.start, so a mistyped option never starts Hal. Tasks: cb, 81y.

import type { Delivery } from '../common/protocol.ts'

export type Args =
	| { kind: 'terminal' }
	| { kind: 'help' }
	| { kind: 'version' }
	| { kind: 'auth' }
	| { kind: 'serve' }
	| { kind: 'remote'; host?: string }
	| { kind: 'print'; prompt: string; dir?: string; model?: string; session?: string; keep?: true; noUser?: true; delivery?: Delivery }
	| { kind: 'error'; message: string }

const usage = `Usage:
  hal                                    start the terminal client
  hal -p <prompt> [-d <dir>] [-m <model>] run one prompt, print the reply
    --session <id|tab>                   send to an existing session (default: soft-steer)
    --steer | --soft-steer | --queue     delivery to a busy session
    --keep                              keep a newly created tab open
    --no-user                           leave your notes (USER.md) out of the new tab's prompt
  hal -r [host]                          follow a remote Hal
  hal serve                              run the foreground headless host
  hal auth                               print a one-time web login code
  hal -v, --version                      show the version, commit and checkout
  hal -h, --help                         show this help
`

function parse(argv: string[]): Args {
	let [first, ...rest] = argv
	if (first === undefined) return { kind: 'terminal' }
	if (argv.length === 1 && ['-h', '--help', 'help'].includes(first)) return { kind: 'help' }
	if (argv.length === 1 && ['-v', '--version'].includes(first)) return { kind: 'version' }
	if (first === 'serve' && !rest.length) return { kind: 'serve' }
	if (first === 'auth' && !rest.length) return { kind: 'auth' }
	if (first === '-r' && rest.length <= 1) return rest[0] === undefined ? { kind: 'remote' } : rest[0].startsWith('-') ? { kind: 'error', message: `-r: unexpected ${rest[0]}` } : { kind: 'remote', host: rest[0] }
	if (!argv.includes('-p') && !argv.includes('--print')) return { kind: 'error', message: `unknown arguments: ${argv.join(' ')}` }
	let opts: { prompt?: string; dir?: string; model?: string; print?: true; session?: string; keep?: true; noUser?: true; delivery?: Delivery } = {}
	let names: Record<string, 'dir' | 'model' | 'session'> = { '-d': 'dir', '--dir': 'dir', '-m': 'model', '--model': 'model', '-s': 'session', '--session': 'session' }
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i]!
		let name = names[arg]
		if (arg === '-p' || arg === '--print') {
			if (opts.print) return { kind: 'error', message: `${arg} given twice` }
			opts.print = true
		} else if (arg === '--keep' || arg === '--no-user') {
			let key: 'keep' | 'noUser' = arg === '--keep' ? 'keep' : 'noUser'
			if (opts[key]) return { kind: 'error', message: `${arg} given twice` }
			opts[key] = true
		} else if (['--steer', '--soft-steer', '--queue'].includes(arg)) {
			if (opts.delivery) return { kind: 'error', message: 'choose one delivery flag' }
			opts.delivery = arg.slice(2) as Delivery
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
	if (opts.session && opts.keep) return { kind: 'error', message: '--keep cannot be used with --session' }
	if (opts.session && opts.noUser) return { kind: 'error', message: '--no-user applies to a new tab, not --session' }
	if (opts.session && opts.dir) return { kind: 'error', message: '--dir cannot be used with --session; use /cd to change its directory' }
	let { print: _print, ...job } = opts
	return { kind: 'print', ...job, prompt: opts.prompt }
}

export const args = { usage: () => usage, parse }
