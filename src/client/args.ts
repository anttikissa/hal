// Command-line arguments (task cb): one pure parse, run first in
// main.start, so a mistyped option never starts Hal. Tasks: cb, 81y.

import type { Delivery } from '../common/protocol.ts'

export type Args =
	| { kind: 'terminal'; noUser?: true }
	| { kind: 'help' }
	| { kind: 'version' }
	| { kind: 'auth' }
	| { kind: 'serve'; noUser?: true; port?: number }
	| { kind: 'remote'; host?: string }
	| { kind: 'print'; prompt: string; dir?: string; model?: string; session?: string; keep?: true; noUser?: true; delivery?: Delivery }
	| { kind: 'error'; message: string }

const usage = `Usage:
  hal                                     start the terminal client
  hal -p <prompt> [-d <dir>] [-m <model>] run one prompt, print the reply
    --session <id|tab>                    send to an existing session (default: soft-steer)
    --steer | --soft-steer | --queue      delivery to a busy session
    --keep                                keep a newly created tab open
  hal -r [host]                           follow a remote Hal
  hal serve [--port <n>]                  run the foreground headless host;
                                          --port: web only on port n, else exit
  hal auth                                print a one-time web login code
  hal -v, --version                       show the version, commit and checkout
  hal -h, --help                          show this help

Host options (hal, hal serve, hal -p; used only by the process that hosts):
  --no-user                               leave your notes (USER.md) out of every tab's prompt
`

// --no-user belongs to the process, which uses it only if it hosts.
function parse(argv: string[]): Args {
	let at = argv.indexOf('--no-user')
	if (at < 0) return args.parseRest(argv)
	if (argv.indexOf('--no-user', at + 1) >= 0) return { kind: 'error', message: '--no-user given twice' }
	let out = args.parseRest(argv.toSpliced(at, 1))
	if (out.kind === 'terminal' || out.kind === 'serve' || out.kind === 'print') return { ...out, noUser: true }
	return out.kind === 'error' ? out : { kind: 'error', message: '--no-user applies only to hal, hal serve and hal -p' }
}

function parseRest(argv: string[]): Args {
	let [first, ...rest] = argv
	if (first === undefined) return { kind: 'terminal' }
	if (argv.length === 1 && ['-h', '--help', 'help'].includes(first)) return { kind: 'help' }
	if (argv.length === 1 && ['-v', '--version'].includes(first)) return { kind: 'version' }
	if (first === 'serve') {
		if (!rest.length) return { kind: 'serve' }
		let n = Number(rest[1])
		if (rest[0] !== '--port' || rest.length !== 2 || !Number.isInteger(n) || n < 1 || n > 65535) return { kind: 'error', message: `hal serve takes only --port <1-65535>, got: ${rest.join(' ')}` }
		return { kind: 'serve', port: n }
	}
	if (first === 'auth' && !rest.length) return { kind: 'auth' }
	if (first === '-r' && rest.length <= 1) return rest[0] === undefined ? { kind: 'remote' } : rest[0].startsWith('-') ? { kind: 'error', message: `-r: unexpected ${rest[0]}` } : { kind: 'remote', host: rest[0] }
	if (!argv.includes('-p') && !argv.includes('--print')) return { kind: 'error', message: `unknown arguments: ${argv.join(' ')}` }
	let opts: { prompt?: string; dir?: string; model?: string; print?: true; session?: string; keep?: true; delivery?: Delivery } = {}
	let names: Record<string, 'dir' | 'model' | 'session'> = { '-d': 'dir', '--dir': 'dir', '-m': 'model', '--model': 'model', '-s': 'session', '--session': 'session' }
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i]!
		let name = names[arg]
		if (arg === '-p' || arg === '--print') {
			if (opts.print) return { kind: 'error', message: `${arg} given twice` }
			opts.print = true
		} else if (arg === '--keep') {
			if (opts.keep) return { kind: 'error', message: `${arg} given twice` }
			opts.keep = true
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
	if (opts.session && opts.dir) return { kind: 'error', message: '--dir cannot be used with --session; use /cd to change its directory' }
	let { print: _print, ...job } = opts
	return { kind: 'print', ...job, prompt: opts.prompt }
}

export const args = { usage: () => usage, parse, parseRest }
