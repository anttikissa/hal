// Running slash commands (commands.ts) in a session: recorded as typed,
// run on the host, their output recorded and broadcast, and a question
// they ask kept in history until answered (prompts.reply).

import { forms, type Answers } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { commands, type Context, type Reply } from './commands.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { models as modelList } from './models.ts'
import { sessions } from './sessions.ts'
import { host } from './host.ts'
import { status } from './status.ts'

// Records a slash command as typed (by whom: `from`, else the human) and
// runs it. `command`: the client's id for the submit. Returns why it is
// refused: no such command.
function command(id: string, text: string, call: { name: string; args: string }, command?: string, from?: string): string | undefined {
	if (!commands.all().has(call.name)) return `unknown command /${call.name} (/help lists them)`
	let record: Omit<HistoryRecord & { type: 'command' }, 'ts'> = { type: 'command', text }
	if (from !== undefined) record.from = from
	if (command !== undefined) record.command = command
	let { n } = history.append(id, record)
	host.broadcast(id, { type: 'command', sessionId: id, text, ...(from !== undefined && { from }), n, ...(command !== undefined && { command }), ...slash.placed(id) })
	void slash.runCommand(id, call.name, call.args)
}

// What a command runs with: its session, whose cwd and model it may
// change.
function context(id: string): Context {
	let meta = sessions.open(id)
	return {
		sessionId: id,
		cwd: meta.cwd,
		model: meta.model,
		setCwd: (cwd) => slash.change(id, { cwd }),
		setModel: (model) => slash.change(id, { model }),
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
	if (patch.model !== undefined && patch.model !== meta.model) changed.model = patch.model
	if (!Object.keys(changed).length) return
	Object.assign(meta, changed)
	liveFiles.save(meta)
	history.append(id, { type: 'change', ...changed })
	host.broadcast(id, { type: 'meta', sessionId: id, meta: { ...meta } })
}

// Runs command `name` (again, with `answers`, once its question is
// answered) and records what it said. A command asks only when no turn
// is busy and no other question is open.
async function runCommand(id: string, name: string, args: string, answers?: Answers): Promise<void> {
	let reply: Reply
	try {
		let cmd = commands.all().get(name)
		if (!cmd) throw new Error(`unknown command /${name}`)
		reply = await cmd.run(args, answers, slash.context(id))
	} catch (e: any) {
		reply = { error: String(e?.message ?? e) }
	}
	if (reply.say !== undefined) slash.output(id, reply.say)
	if (reply.error !== undefined) slash.output(id, reply.error, true)
	if (reply.open === 'models') void slash.models(id).then((e) => host.broadcast(id, e))
	if (!reply.ask) return
	let problem = forms.invalid(reply.ask)
	if (problem) return slash.output(id, `/${name} asked a bad question: ${problem}`, true)
	// A session blocked on something other than a question (a login)
	// waits for a human anyway, so /login claude may ask there.
	let now = status.stateOf(id)
	if (states.busy(now) && !(now.type === 'blocked' && now.reason !== 'question'))
		return slash.output(id, `/${name} can't ask while the session is busy; try again when it is done`, true)
	let question = crypto.randomUUID().slice(0, 8)
	let before = status.stateOf(id)
	let { n } = history.append(id, { type: 'question', id: question, form: reply.ask, from: { command: name, args } })
	host.broadcast(id, { type: 'question', sessionId: id, id: question, form: reply.ask, n })
	status.settle(id, before)
}

// The model picker's content for session `id`.
async function models(id: string): Promise<Event & { type: 'models' }> {
	let current = sessions.open(id).model
	let items = await modelList.list(current)
	return { type: 'models', sessionId: id, current, items, names: modelList.names(items) }
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
	runCommand,
	models,
	output,
	placed,
}
