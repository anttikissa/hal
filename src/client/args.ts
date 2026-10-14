// Command-line arguments: declared once, parsed purely before Hal
// starts, and rendered as help. Tasks: cb, 81y, 100.

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

type Kind = Exclude<Args['kind'], 'error'>
type Out = { kind: Kind; home?: string; noUser?: true; port?: number; prompt?: string; host?: string; dir?: string; model?: string; session?: string; keep?: true; delivery?: Delivery }
type Entry = { syntax: string; names: string[]; value?: string; help: string; kind?: Kind; within?: Entry; set?: (out: Out, value: string) => void }

class UsageError extends Error {}
const fail = (message: string): never => { throw new UsageError(message) }

const commands: Entry[] = []
const options: Entry[] = []
let within: Entry | undefined

function entry(syntax: string, help: string): Entry {
	let [names, value] = syntax.split(/ (?=[<[])/)
	return { syntax, names: names!.split(', '), value, help }
}

// The command's operand, if any, goes to the field its value names: -r [host] sets host.
function command(syntax: string, help: string, kind: Kind, declareOptions = () => {}): void {
	within = { ...entry(syntax, help), kind }
	commands.push(within)
	declareOptions()
	within = undefined
}

function arg(syntax: string, help: string, set: (out: Out, value: string) => void): void {
	options.push({ ...entry(syntax, help), within, set })
}

const deliver = (delivery: Delivery) => (out: Out) => { out.delivery = out.delivery ? fail('choose one delivery flag') : delivery }

command('-p, --print <prompt>', 'Run one prompt and print the reply', 'print', () => {
	arg('-d, --dir <dir>', 'Working directory for the new tab', (out, dir) => { out.dir = dir })
	arg('-m, --model <model>', 'Model to use', (out, model) => { out.model = model })
	arg('-s, --session <id|tab>', 'Send to an existing session instead', (out, session) => { out.session = session })
	arg('--steer', 'Interrupt a busy session at its next boundary', deliver('steer'))
	arg('--soft-steer', 'Let a busy session finish its current step (default)', deliver('soft-steer'))
	arg('--queue', 'Wait until a busy session finishes its turn', deliver('queue'))
	arg('--keep', 'Keep the new tab open afterwards', out => { out.keep = true })
})
command('-r [host]', 'Follow a remote Hal', 'remote')
command('serve', 'Run the foreground headless host', 'serve', () => {
	arg('--port <1-65535>', 'Serve the web client on this port, or exit', (out, port) => {
		out.port = /^\d+$/.test(port) && +port >= 1 && +port <= 65535 ? +port : fail(`--port needs 1-65535, got ${port}`)
	})
})
command('auth', 'Print a one-time web login code', 'auth')
command('-v, --version', 'Show the version, commit and checkout', 'version')
command('-h, --help, help', 'Show this help', 'help')
arg('--home <dir>', 'Use this Hal home instead of the checkout', (out, dir) => { out.home = dir })
arg('--no-user', 'Leave USER.md out of prompts when this process hosts', out => { out.noUser = true })

function usage(): string {
	let column = Math.max(...[...commands, ...options].map(e => e.syntax.length)) + 6
	let rows = (list: Entry[], indent: string) => list.map(e => indent + e.syntax.padEnd(column - indent.length) + e.help)
	return [
		'Usage: hal [command] [options]', '', 'Without a command, hal starts the terminal client.', '', 'Commands:',
		...commands.flatMap(c => [...rows([c], '  '), ...rows(options.filter(o => o.within === c), '    ')]),
		'', 'Options:', ...rows(options.filter(o => !o.within), '  '), '',
	].join('\n')
}

const find = (list: Entry[], token: string) => list.find(e => e.names.includes(token))

function parse(argv: string[]): Args {
	try {
		let out: Out = { kind: 'terminal' }
		let used = new Set<Entry>()
		let words: string[] = []
		let selected: Entry | undefined
		for (let i = 0; i < argv.length; i++) {
			let token = argv[i]!
			let found = find(options, token) ?? (token.startsWith('-') ? find(commands, token) : undefined)
			if (!found && token.startsWith('-')) fail(`unknown option ${token}`)
			if (!found) { words.push(token); continue }
			if (used.has(found)) fail(`${token} given twice`)
			used.add(found)
			if (found.kind) { selected = selected ? fail(`${token} conflicts with ${selected.names[0]}`) : found; continue }
			let value = found.value ? argv[++i] : ''
			if (found.value && (!value || value.startsWith('-'))) fail(`${token} needs ${found.value}`)
			found.set!(out, value!)
		}
		// Bare command words count only without a flag command: in "hal -p help", help is the prompt.
		let bare = selected ? undefined : words.shift()
		if (bare) selected = find(commands, bare) ?? fail(`unknown command ${bare}`)
		let operand = selected?.value ? words.shift() : undefined
		if (words.length) fail(`unexpected argument ${words[0]}`)
		if (selected?.value?.startsWith('<') && !operand?.trim()) fail(`${selected.names[0]} needs ${selected.value}`)
		if (selected) out.kind = selected.kind!
		if (operand) out[selected!.value!.slice(1, -1) as 'prompt' | 'host'] = operand
		for (let e of used) if (e.within && e.within !== selected) fail(`${e.names[0]} applies only to hal ${e.within.names[0]}`)
		if (out.noUser && !['terminal', 'serve', 'print'].includes(out.kind)) fail('--no-user applies only to hal, hal serve and hal -p')
		if (out.session && out.keep) fail('--keep cannot be used with --session')
		if (out.session && out.dir) fail('--dir cannot be used with --session; use /cd to change its directory')
		return out as Args
	} catch (e) {
		if (e instanceof UsageError) return { kind: 'error', message: e.message }
		throw e
	}
}

export const args = { usage, parse }
