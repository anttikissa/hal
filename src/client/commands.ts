// The terminal's side of the command list (common/commands/list.ts):
// client-only commands run here from src/client/commands/<name>.ts,
// typed or by key, and never reach the host. The tab keys (new, close,
// resume) also run here, sending the tab command unrecorded; typed,
// those are host commands. Any other host command's key sends
// `/<name>` as if typed. The emergency keys never get here
// (client/terminal.ts takes them from raw stdin).

import { commandList } from '../common/commands/list.ts'
import { drafts } from '../common/drafts.ts'
import { app } from './app.ts'
import type { KeyEvent } from './keys.ts'
import { command as close } from './commands/close.ts'
import { command as newTab } from './commands/new.ts'
import { command as quit } from './commands/quit.ts'
import { command as redraw } from './commands/redraw.ts'
import { command as restart } from './commands/restart.ts'
import { command as resume } from './commands/resume.ts'
import { command as suspend } from './commands/suspend.ts'
import { find } from './find.ts'

export type ClientCommand = { run(): void }

const all: Record<string, ClientCommand> = { close, new: newTab, quit, redraw, restart, resume, suspend }

// Runs command `name` bare. Ctrl-M only asks for the model picker, to
// this client alone and unrecorded (tasks/w4/forms.md, Provenance).
function run(name: string): void {
	if (name === 'find') return find.open()
	let local = clientCommands.all[name]
	if (local) return local.run()
	let id = app.state.transcript?.meta.id
	if (id === undefined) return
	app.send(name === 'model' ? { type: 'models', sessionId: id } : { type: 'submit', sessionId: id, text: `/${name}` })
}

// A command's key: true if `k` was one (and it ran).
function key(k: KeyEvent): boolean {
	let c = commandList.byKey(k)
	if (c) clientCommands.run(c.name)
	return !!c
}

// Typed `text` as a client-only command: true if it was one (and it
// ran, the draft emptied first so a restart does not bring it back).
function typed(text: string): boolean {
	let t = text.trim()
	// /restart both goes on to the host, marking this client to follow.
	if (/^\/restart\s+both$/.test(t)) restart.withHost()
	let name = /^\/restart(\s+local)?$/.test(t) ? 'restart' : /^\/([a-z][a-z0-9-]*)$/.exec(t)?.[1]
	if (name !== 'restart' && (!name || !commandList.byName(name)?.clientOnly || !clientCommands.all[name])) return false
	let id = app.state.transcript?.meta.id
	if (id !== undefined) drafts.edit(id, '')
	clientCommands.run(name)
	return true
}

export const clientCommands = { all, run, key, typed }
