// Running slash commands (commands.ts) in a session: recorded as typed,
// run on the host, their output recorded and broadcast, and a question
// they ask kept in history until answered (prompts.reply).

import { commandList } from '../common/commands/list.ts'
import { forms, type Answers } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { auth } from './auth.ts'
import { commands, type Context, type Reply } from './commands.ts'
import { history } from './history.ts'
import { naming } from './naming.ts'
import { liveFiles } from './live-file.ts'
import { models as modelList } from './models.ts'
import { sessions } from './sessions.ts'
import { host } from './host.ts'
import { stats } from './stats.ts'
import { turns } from './turns.ts'
import { effort } from './effort.ts'

// Records a slash command as typed (by whom: `from`, else the human) and
// runs it. `command`: the client's id for the submit. Returns why it is
// refused: no such command, or one only a client may run (a session may
// not quit or restart the user's terminal).
function command(id: string, text: string, call: { name: string; args: string }, command?: string, from?: string, completed?: (reply: Reply) => void): string | undefined {
	if (commandList.byName(call.name)?.clientOnly) return `only a client can run /${call.name}`
	if (call.name === 'budget' && from !== undefined) return 'only a human can run /budget'
	if (!commands.all().has(call.name)) return `unknown command /${call.name} (/help lists them)`
	text = commands.all().get(call.name)!.record?.(call.args) ?? text
	let record: Omit<HistoryRecord & { type: 'command' }, 'ts'> = { type: 'command', text }
	if (from !== undefined) record.from = from
	if (command !== undefined) record.command = command
	let { n, ts } = history.append(id, record)
	host.broadcast(id, { type: 'command', sessionId: id, text, ...(from !== undefined && { from }), ts, n, ...(command !== undefined && { command }), ...slash.placed(id) })
	void slash.runCommand(id, call.name, call.args).then((reply) => completed?.(reply))
}

// What a command runs with: its session, whose cwd and model it may
// change.
function context(id: string): Context {
	let meta = sessions.open(id)
	return {
		sessionId: id,
		cwd: meta.cwd,
		model: meta.model,
		effort: meta.effort,
		setCwd: (cwd) => slash.change(id, { cwd }),
		setModel: (model) => slash.change(id, { model }),
		setName: (name) => slash.name(id, name),
		say: (text) => slash.output(id, text),
	}
}

// Changes the session's cwd or model: saved, told to followers, and
// recorded for the model's next prompt (replay.changeNotes). The system
// prompt of the next request follows by itself.
function change(id: string, patch: { cwd?: string; model?: string }): void {
	let meta = sessions.open(id)
	let changed: typeof patch = {}
	if (patch.cwd !== undefined && patch.cwd !== meta.cwd) changed.cwd = patch.cwd
	let selection = patch.model === undefined ? undefined : modelList.selection(patch.model)
	if (selection && (selection.id !== meta.model || selection.effort !== meta.effort)) changed.model = modelList.qualified(selection.id, selection.effort)
	if (!Object.keys(changed).length) return
	if (changed.cwd !== undefined) meta.cwd = changed.cwd
	if (changed.model !== undefined && selection) {
		meta.model = selection.id
		if (selection.effort === undefined) delete meta.effort
		else meta.effort = selection.effort
	}
	liveFiles.save(meta)
	history.append(id, { type: 'change', ...changed })
	host.broadcast(id, changed.model === undefined ? { type: 'meta', sessionId: id, meta: { ...meta } } : { type: 'meta', sessionId: id, meta: { ...meta }, stats: stats.of(id) })
	if (changed.model) {
		// A turn waiting out a failure tries the new model now.
		turns.state.running.get(id)?.rewait?.abort()
		let names = modelList.names([changed.model])
		if (Object.keys(names).length) host.broadcast(id, { type: 'model-names', names })
	}
}

// Session names change tab labels but not the model's working context.
function name(id: string, value?: string): void {
	naming.manual(id, value)
}
// Runs command `name` (again, with `answers`, once its question is
// answered) and records what it said.
async function runCommand(id: string, name: string, args: string, answers?: Answers): Promise<Reply> {
	let reply: Reply
	try {
		let cmd = commands.all().get(name)
		if (!cmd) throw new Error(`unknown command /${name}`)
		reply = await cmd.run(args, answers, slash.context(id))
	} catch (e: any) {
		reply = { error: String(e?.message ?? e) }
	}
	if (reply.say !== undefined) slash.output(id, reply.say)
	if (reply.show !== undefined) host.broadcast(id, { type: 'output', sessionId: id, text: reply.show, ...slash.placed(id) })
	if (reply.error !== undefined) slash.output(id, reply.error, true)
	if (reply.open === 'models') void slash.models(id).then((e) => host.broadcast(id, e))
	if (!reply.ask) return reply
	let problem = forms.invalid(reply.ask)
	if (problem) {
		let error = `/${name} asked a bad question: ${problem}`
		slash.output(id, error, true)
		return { error }
	}
	// A command's question is not the turn's: it opens beside whatever
	// the session does (a turn blocked on a login is the point of /login)
	// and leaves the state alone. Only a turn's open question, which the
	// turn waits on, keeps it out; a command's earlier one it replaces.
	let open = forms.open(history.readSync(id))
	if (open && !open.from) {
		let error = `/${name} can't ask while a question is open; answer it first`
		slash.output(id, error, true)
		return { error }
	}
	if (open) slash.dismiss(id, open.id)
	let question = crypto.randomUUID().slice(0, 8)
	let { n } = history.append(id, { type: 'question', id: question, form: reply.ask, from: { command: name, args: reply.askArgs ?? args } })
	host.broadcast(id, { type: 'question', sessionId: id, id: question, form: reply.ask, n, command: true, ...slash.placed(id) })
	return reply
}

// The model picker's content for session `id`.
async function models(id: string): Promise<Event & { type: 'models' }> {
	let current = sessions.open(id).model
	let items = await modelList.list(current)
	let capabilities = Object.fromEntries(items.flatMap((model) => { let cap = effort.describe(model); return cap ? [[model, cap]] : [] }))
	return { type: 'models', sessionId: id, current, effort: sessions.open(id).effort, capabilities, items, names: modelList.names(items) }
}

// Closes question `question` unanswered: Escape, or a newer one
// replaces it. Whoever asked is not run again.
function dismiss(id: string, question: string): void {
	history.append(id, { type: 'answer', question, answers: {}, cancelled: true })
	host.broadcast(id, { type: 'answer', sessionId: id, question, answers: {}, cancelled: true })
}

function output(id: string, text: string, error = false): void {
	let { n } = history.append(id, error ? { type: 'output', text, error } : { type: 'output', text })
	host.broadcast(id, error ? { type: 'output', sessionId: id, text, error, n, ...slash.placed(id) } : { type: 'output', sessionId: id, text, n, ...slash.placed(id) })
}

// Where a command's record landed beside a running turn: before the
// block still streaming, if any (it is written when done), so clients
// fold it where history has it (task rk).
function placed(id: string): { streaming?: true } {
	return history.live(id)?.blocks.length ? { streaming: true } : {}
}

export const slash = {
	command,
	context,
	change,
	name,
	runCommand,
	models,
	dismiss,
	output,
	placed,
}

// A session falling back to a paid API key says so where the user reads.
auth.fallback = (id, text) => slash.output(id, text)
