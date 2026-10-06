// Slash commands (tasks/w4/forms.md, Commands): one file per command in
// src/host/commands/, named like it (cd.ts is /cd), found by listing the
// directory, so adding a command touches nothing else. Each exports
// `command`, a SlashCommand. They run on the host, completion included,
// so every client gets the same. Name, description, category and key
// are in the shared list (common/commands/list.ts), which also names the
// client-only commands the host never runs. Nothing waits in memory: a command
// that needs to ask returns a form, and the answer runs it again with
// `answers`.

import { readdirSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import { commandList } from '../common/commands/list.ts'
import type { Sender } from '../common/blocks.ts'
import type { Answers, Form } from '../common/forms.ts'

// What a command did: something to say, a failure, or a question.
// `result`: tool acknowledgement when durable output was already recorded.
// `open`: a client modal to open on every client following the session
// (tasks/w4/forms.md, Provenance): 'models' is the model picker.
// `show`: said like `say` but never recorded, so it is gone on the next
// snapshot (a one-time code, /auth).
export type Reply = { result?: string; say?: string; show?: string; error?: string; ask?: Form; askArgs?: string; open?: 'models' | 'settings'; rebase?: import('../common/rebase-rows.ts').RebaseRows }

// The session the command runs in.
// setCwd and setModel also tell the model, on its next prompt; say
// records output while the command still runs (a login that waits).
export type Context = { sessionId: string; sender?: Sender; cwd: string; previousCwd?: string; model: string; effort?: string; setCwd(cwd: string): void; setModel(model: string): void; setName?(name?: string): void; say(text: string): void }

export type Candidate = { value: string; description: string }

export type SlashCommand = {
	// Refuse a bad answer before recording it or closing the question.
	checkAnswers?(args: string, answers: Answers): string | undefined
	// Safe or readable command text for history and other clients
	// (secret arguments; ids shown as positions). `id`: the session.
	record?(args: string, id: string): string | undefined
	// The detail /help <name> shows; `args` follow the name.
	help?(args: string): string
	// Full argument texts `args` may complete to, each with an optional
	// description the clients show beside it.
	complete?(args: string, ctx: Context): (string | Candidate)[]
	// Optional detail for each candidate, resolved on the host.
	describeCompletion?(args: string, ctx: Context): string
	run(args: string, answers: Answers | undefined, ctx: Context): Reply | Promise<Reply>
}

function dir(): string {
	return `${import.meta.dir}/commands`
}

// Every command by name, sorted, read from the directory each time.
function all(): Map<string, SlashCommand> {
	let found = new Map<string, SlashCommand>()
	for (let file of readdirSync(commands.dir()).sort()) {
		if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
		let name = file.slice(0, -3), path = `${commands.dir()}/${file}`
		// One module that fails to load (e.g. it needs code newer than the
		// running host's module cache) breaks only its own command, which
		// reports the full error, never every other command.
		try { found.set(name, require(path).command) }
		catch (e) { found.set(name, { run: () => ({ error: `/${name} failed to load from ${path}: ${e instanceof Error ? e.stack ?? e.message : String(e)}` }) } as SlashCommand) }
	}
	return found
}

// "/name args" as its parts; undefined for anything else, such as a
// prompt that starts with a path ("/tmp/x is broken").
function parse(text: string): { name: string; args: string } | undefined {
	let m = /^\/([a-z][a-z0-9-]*)(?:\s([\s\S]*))?$/.exec(text.trimStart())
	return m ? { name: m[1]!, args: m[1] === 'clear' ? m[2] ?? '' : (m[2] ?? '').trim() } : undefined
}

// Every full text `text` may complete to: a command name, or what the
// command completes its arguments to, with the command's descriptions.
function candidates(text: string, ctx: Context): (string | Candidate)[] {
	let bare = /^\/([a-z0-9-]*)$/.exec(text)
	if (bare && commandList.byName(bare[1]!)?.defaultArgs !== undefined) text += ' '
	else if (bare) return commandList.all().filter((c) => !c.hidden).map((c) => c.name).filter((n) => n.startsWith(bare[1]!)).map((n) => `/${n} `)
	let m = /^\/([a-z][a-z0-9-]*)\s([\s\S]*)$/.exec(text)
	let cmd = m && commands.all().get(m[1]!)
	if (!m || commandList.byName(m[1]!)?.hidden || !cmd?.complete) return []
	try {
		return cmd.complete(m[2]!, ctx).map((a) => typeof a === 'string' ? `/${m[1]} ${a}` : { value: `/${m[1]} ${a.value}`, description: a.description })
	} catch {
		return []
	}
}

function complete(text: string, ctx: Context): string[] {
	return commands.candidates(text, ctx).map((c) => typeof c === 'string' ? c : c.value)
}

// Keep replacement strings compatible with terminal completion; optional
// aligned descriptions let richer clients show the actual host-side choice.
function suggestions(text: string, ctx: Context): { items: string[]; descriptions?: string[] } {
	let found = commands.candidates(text, ctx)
	let items = found.map((c) => typeof c === 'string' ? c : c.value)
	if (found.some((c) => typeof c !== 'string')) return { items, descriptions: found.map((c) => typeof c === 'string' ? '' : c.description) }
	let parsed = commands.parse(text)
	let cmd = parsed && commands.all().get(parsed.name)
	return cmd?.describeCompletion ? { items, descriptions: items.map((item) => cmd.describeCompletion!(commands.parse(item)!.args, ctx)) } : { items }
}

// `path` as an absolute path: ~ is the home directory, and a relative
// path starts at `cwd`.
function expand(path: string, cwd: string): string {
	if (path === '~' || path.startsWith('~/')) path = commands.home() + path.slice(1)
	return resolve(cwd, path)
}

export const commands = {
	dir,
	home: (): string => homedir(),
	all,
	parse,
	candidates,
	complete,
	suggestions,
	expand,
}
