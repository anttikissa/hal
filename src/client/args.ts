// CLI declarations, generated help and pure validation before Hal starts.
// Tasks: cb, 81y, 100.

import type { Delivery } from '../common/protocol.ts'

export type Args = (
	| { kind: 'terminal'; noUser?: true }
	| { kind: 'help' }
	| { kind: 'version' }
	| { kind: 'auth' }
	| { kind: 'serve'; noUser?: true; port?: number }
	| { kind: 'remote'; host?: string }
	| { kind: 'print'; prompt: string; dir?: string; model?: string; session?: string; keep?: true; noUser?: true; delivery?: Delivery }
	| { kind: 'error'; message: string }
) & { home?: string }

type Mode = Exclude<Args['kind'], 'error'>
type Options = {
	home?: string
	noUser?: true
	port?: string
	dir?: string
	model?: string
	session?: string
	keep?: true
	delivery?: Delivery
}
type Spelling = { syntax: string; names: string[]; value?: string; help: string }
type Option = Spelling & { mode?: Mode; handle: (value: string) => void }
type Command = Spelling & { mode: Mode }
type Definitions = { commands: Command[]; options: Option[] }

function declarations(values: Options): Definitions {
	let commands: Command[] = [], options: Option[] = []
	let scope: Mode | undefined

	function spelling(syntax: string, help: string): Spelling {
		let [names, value] = syntax.split(/ (?=[<[])/)
		return { syntax, names: names!.split(', '), value, help }
	}
	function arg(syntax: string, help: string, handle: (value: string) => void): void {
		options.push({ ...spelling(syntax, help), mode: scope, handle })
	}
	function flag(syntax: string, help: string, handle: () => void): void {
		arg(syntax, help, handle)
	}
	function command(syntax: string, help: string, mode: Mode, configure?: () => void): void {
		commands.push({ ...spelling(syntax, help), mode })
		scope = mode
		configure?.()
		scope = undefined
	}

	arg('--home <dir>', 'Use this Hal home instead of the checkout', dir => { values.home = dir })
	flag('--no-user', 'Omit USER.md from prompts when this process hosts Hal (terminal, serve, -p)', () => { values.noUser = true })

	command('-p, --print <prompt>', 'Run one prompt and print the reply; quote prompts containing spaces', 'print', () => {
		arg('-d, --dir <dir>', 'Working directory for a new session', dir => { values.dir = dir })
		arg('-m, --model <model>', 'Model for the prompt', model => { values.model = model })
		arg('-s, --session <id|tab>', 'Send to an existing session (default delivery: soft-steer)', session => { values.session = session })
		flag('--steer', 'Interrupt the busy session at its next boundary', () => { values.delivery = 'steer' })
		flag('--soft-steer', 'Let the busy session finish its current step', () => { values.delivery = 'soft-steer' })
		flag('--queue', 'Wait for the busy session to finish its turn', () => { values.delivery = 'queue' })
		flag('--keep', 'Keep a newly created tab open; not with --session', () => { values.keep = true })
	})
	command('-r [host]', 'Follow a remote Hal', 'remote')
	command('serve', 'Run the foreground headless host', 'serve', () => {
		arg('--port <1-65535>', 'Serve the web client on this port, or exit if unavailable', port => { values.port = port })
	})
	command('auth', 'Print a one-time web login code', 'auth')
	command('-v, --version', 'Show the version, commit and checkout', 'version')
	command('-h, --help, help', 'Show this help', 'help')
	return { commands, options }
}

function usage(): string {
	let { commands, options } = args.declarations({})
	let width = Math.max(...[...commands, ...options].map(entry => entry.syntax.length))
	let row = (entry: Spelling, indent = '  ') => `${indent}${entry.syntax.padEnd(width)}  ${entry.help}`
	let lines = ['Usage: hal [command] [options]', '', 'With no command, start the terminal client.', '', 'Commands:']
	for (let command of commands) {
		lines.push(row(command))
		for (let option of options.filter(option => option.mode === command.mode)) lines.push(row(option, '    '))
	}
	lines.push('', 'Shared options:', ...options.filter(option => !option.mode).map(option => row(option)))
	return `${lines.join('\n')}\n`
}

function error(message: string): Extract<Args, { kind: 'error' }> {
	return { kind: 'error', message }
}

function scan(argv: string[], definitions: Definitions): { kind: Mode; operand?: string; used: Set<Option> } | Extract<Args, { kind: 'error' }> {
	let { commands, options } = definitions
	let selected: Command | undefined
	let words: string[] = []
	let used = new Set<Option>()

	for (let i = 0; i < argv.length; i++) {
		let token = argv[i]!
		let option = options.find(option => option.names.includes(token))
		if (option) {
			if (used.has(option)) return args.error(`${token} given twice`)
			let value = ''
			if (option.value) {
				let next = argv[++i]
				if (!next || next.startsWith('-')) return args.error(`${token} needs ${option.value}`)
				value = next
			}
			used.add(option)
			option.handle(value)
		} else if (token.startsWith('-') && token !== '-') {
			let command = commands.find(command => command.names.includes(token))
			if (!command) return args.error(`unknown option ${token}`)
			if (selected) return args.error(`${token} conflicts with ${selected.names[0]}`)
			selected = command
		} else {
			words.push(token)
		}
	}

	// Resolve bare commands after flags: in "hal -p help", help is the prompt.
	if (!selected && words.length) {
		selected = commands.find(command => command.names.includes(words[0]!))
		if (!selected) return args.error(`unknown command ${words[0]}`)
		words.shift()
	}
	let kind = selected?.mode ?? 'terminal'
	for (let option of used) {
		if (!option.mode || option.mode === kind) continue
		let command = commands.find(command => command.mode === option.mode)!
		return args.error(`${option.names[0]} applies only to hal ${command.names[0]}`)
	}
	let operand = words[0]
	if (words.length > (selected?.value ? 1 : 0)) return args.error(`unexpected argument ${words[selected?.value ? 1 : 0]}`)
	if (selected?.value?.startsWith('<') && !operand?.trim()) return args.error(`${selected.names[0]} needs ${selected.value}`)
	if (kind === 'remote' && operand?.startsWith('-')) return args.error(`unknown option ${operand}`)
	return { kind, operand, used }
}

function finish(kind: Mode, operand: string | undefined, values: Options, used: Set<Option>): Args {
	let { home, noUser, port, ...print } = values
	let shared = home === undefined ? {} : { home }
	let hosting = noUser ? { ...shared, noUser } : shared
	if (noUser && !['terminal', 'serve', 'print'].includes(kind)) return args.error('--no-user applies only to hal, hal serve and hal -p')
	if (kind === 'print') {
		let deliveryFlags = [...used].filter(option => ['--steer', '--soft-steer', '--queue'].includes(option.names[0]!))
		if (deliveryFlags.length > 1) return args.error('choose one delivery flag')
		if (print.session && print.keep) return args.error('--keep cannot be used with --session')
		if (print.session && print.dir) return args.error('--dir cannot be used with --session; use /cd to change its directory')
		return { kind, prompt: operand!, ...print, ...hosting }
	}
	if (kind === 'serve') {
		if (port === undefined) return { kind, ...hosting }
		let number = Number(port)
		if (!Number.isInteger(number) || number < 1 || number > 65535) return args.error(`--port needs an integer from 1 to 65535, got: ${port}`)
		return { kind, port: number, ...hosting }
	}
	if (kind === 'remote') return operand === undefined ? { kind, ...shared } : { kind, host: operand, ...shared }
	if (kind === 'terminal') return { kind, ...hosting }
	return { kind, ...shared }
}

function parse(argv: string[]): Args {
	let values: Options = {}
	let parsed = args.scan(argv, args.declarations(values))
	if (parsed.kind === 'error') return parsed
	return args.finish(parsed.kind, parsed.operand, values, parsed.used)
}

export const args = { usage, parse, declarations, scan, finish, error }
