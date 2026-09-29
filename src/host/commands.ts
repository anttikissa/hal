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
import type { Answers, Form } from '../common/forms.ts'

// What a command did: something to say, a failure, or a question.
// `open`: a client modal to open on every client following the session
// (tasks/w4/forms.md, Provenance): 'models' is the model picker.
// `show`: said like `say` but never recorded, so it is gone on the next
// snapshot (a one-time code, /auth).
export type Reply = { say?: string; show?: string; error?: string; ask?: Form; askArgs?: string; open?: 'models' }

// The session the command runs in.
// setCwd and setModel also tell the model, on its next prompt; say
// records output while the command still runs (a login that waits).
export type Context = { sessionId: string; cwd: string; model: string; setCwd(cwd: string): void; setModel(model: string): void; setName?(name?: string): void; say(text: string): void }

export type SlashCommand = {
	// Refuse a bad answer before recording it or closing the question.
	checkAnswers?(args: string, answers: Answers): string | undefined
	// Safe command text for history and other clients (secret arguments).
	record?(args: string): string
	// The detail /help <name> shows; `args` follow the name.
	help?(args: string): string
	// Full argument texts `args` may complete to.
	complete?(args: string, ctx: Context): string[]
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
		found.set(file.slice(0, -3), require(`${commands.dir()}/${file}`).command)
	}
	return found
}

// "/name args" as its parts; undefined for anything else, such as a
// prompt that starts with a path ("/tmp/x is broken").
function parse(text: string): { name: string; args: string } | undefined {
	let m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
	return m ? { name: m[1]!, args: m[2] ?? '' } : undefined
}

// Every full text `text` may complete to: a command name, or what the
// command completes its arguments to.
function complete(text: string, ctx: Context): string[] {
	let bare = /^\/([a-z0-9-]*)$/.exec(text)
	if (bare) return commandList.all().map((c) => c.name).filter((n) => n.startsWith(bare[1]!)).map((n) => `/${n} `)
	let m = /^\/([a-z][a-z0-9-]*)\s([\s\S]*)$/.exec(text)
	let cmd = m && commands.all().get(m[1]!)
	if (!m || !cmd?.complete) return []
	try {
		return cmd.complete(m[2]!, ctx).map((a) => `/${m[1]} ${a}`)
	} catch {
		return []
	}
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
	complete,
	expand,
}
