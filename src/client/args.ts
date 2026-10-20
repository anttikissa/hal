// Parses command-line arguments in one place, before Hal starts. Each
// is declared once and parsed purely; help is a handwritten string.
// Tasks: cb, 81y, 100.

import type { Delivery } from '../common/protocol.ts'

export type Args = (
	| { kind: 'terminal'; noUser?: true }
	| { kind: 'help' }
	| { kind: 'version' }
	| { kind: 'auth'; count?: number }
	| { kind: 'serve'; noUser?: true; port?: number }
	| { kind: 'remote'; host?: string }
	| {
			kind: 'print'
			prompt: string
			dir?: string
			model?: string
			session?: string
			keep?: true
			noUser?: true
			delivery?: Delivery
	  }
	| { kind: 'error'; message: string }
) & { home?: string }

const help = `Usage:
  hal                         start the terminal client
  hal -p <prompt>             run one prompt, print the reply
    -d, --dir <dir>           working directory for the new tab
    -m, --model <model>       model to use
    -s, --session <id|tab>    send to an existing session instead
    --steer | --soft-steer | --queue
                              delivery to a busy session (default: soft-steer)
    --keep                    keep the new tab open; not with --session
  hal -r [host]               connect to a remote Hal (default: the last one)
  hal serve [--port <n>]      run the foreground headless host;
                              --port: web only on port n, else exit
  hal auth [count]            print one-time login codes (default: 1, max: 100)
  hal -v, --version           show the version, commit and checkout
  hal -h, --help              show this help

Options:
  --home <dir>                use this Hal home instead of the checkout
  --no-user                   leave your notes (USER.md) out of every tab's prompt;
                              only for hal, hal serve and hal -p, used by the process that hosts
`

type Kind = Exclude<Args['kind'], 'error'>
type Out = {
	kind: Kind
	home?: string
	noUser?: true
	port?: number
	count?: number
	prompt?: string
	host?: string
	dir?: string
	model?: string
	session?: string
	keep?: true
	delivery?: Delivery
}
type Entry = { names: string[]; value?: string; kind?: Kind; within?: Entry; set?: (out: Out, value: string) => void }

class UsageError extends Error {}
const fail = (message: string): never => {
	throw new UsageError(message)
}

const commands: Entry[] = []
const options: Entry[] = []
let within: Entry | undefined

function entry(syntax: string): Entry {
	let [names, value] = syntax.split(/ (?=[<[])/)
	return { names: names!.split(', '), value }
}

// The command's operand, if any, goes to the field its value names: -r [host] sets host.
function command(syntax: string, kind: Kind, declareOptions = () => {}): void {
	within = { ...entry(syntax), kind }
	commands.push(within)
	declareOptions()
	within = undefined
}

function arg(syntax: string, set: (out: Out, value: string) => void): void {
	options.push({ ...entry(syntax), within, set })
}

const deliver = (delivery: Delivery) => (out: Out) => {
	out.delivery = out.delivery ? fail('choose one delivery flag') : delivery
}

command('-p, --print <prompt>', 'print', () => {
	arg('-d, --dir <dir>', (out, dir) => {
		out.dir = dir
	})
	arg('-m, --model <model>', (out, model) => {
		out.model = model
	})
	arg('-s, --session <id|tab>', (out, session) => {
		out.session = session
	})
	arg('--steer', deliver('steer'))
	arg('--soft-steer', deliver('soft-steer'))
	arg('--queue', deliver('queue'))
	arg('--keep', (out) => {
		out.keep = true
	})
})
command('-r [host]', 'remote')
command('serve', 'serve', () => {
	arg('--port <1-65535>', (out, port) => {
		out.port = /^\d+$/.test(port) && +port >= 1 && +port <= 65535 ? +port : fail(`--port needs 1-65535, got ${port}`)
	})
})
command('auth [count]', 'auth')
command('-v, --version', 'version')
command('-h, --help, help', 'help')
arg('--home <dir>', (out, dir) => {
	out.home = dir
})
arg('--no-user', (out) => {
	out.noUser = true
})

const find = (list: Entry[], token: string) => list.find((e) => e.names.includes(token))

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
			if (!found) {
				words.push(token)
				continue
			}
			if (used.has(found)) fail(`${token} given twice`)
			used.add(found)
			if (found.kind) {
				selected = selected ? fail(`${token} conflicts with ${selected.names[0]}`) : found
				continue
			}
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
		if (operand !== undefined && out.kind === 'auth')
			out.count =
				/^\d+$/.test(operand) && +operand >= 1 && +operand <= 100 ? +operand : fail('auth count must be 1-100')
		else if (operand) out[selected!.value!.slice(1, -1) as 'prompt' | 'host'] = operand
		for (let e of used)
			if (e.within && e.within !== selected) fail(`${e.names[0]} applies only to hal ${e.within.names[0]}`)
		if (out.noUser && !['terminal', 'serve', 'print'].includes(out.kind))
			fail('--no-user applies only to hal, hal serve and hal -p')
		if (out.session && out.keep) fail('--keep cannot be used with --session')
		if (out.session && out.dir) fail('--dir cannot be used with --session; use /cd to change its directory')
		return out as Args
	} catch (e) {
		if (e instanceof UsageError) return { kind: 'error', message: e.message }
		throw e
	}
}

export const args = { usage: () => help, parse }
