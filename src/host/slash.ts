// Running slash commands (commands.ts) in a session: recorded as typed,
// run on the host, their output recorded and broadcast, and a question
// they ask kept in history until answered (prompts.reply).
// Tasks: et, yq, 6eq.

import type { Sender } from '../common/blocks.ts'
import { commandList } from '../common/commands/list.ts'
import { forms, type Answers } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { auth } from './auth.ts'
import { commands, type Context, type Reply } from './commands.ts'
import { config } from './config.ts'
import { history } from './history.ts'
import { naming } from './naming.ts'
import { liveFiles } from './live-file.ts'
import { models as modelList } from './models.ts'
import { prompts } from './prompts.ts'
import { queueEdits } from './queue-edits.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { host } from './host.ts'
import { stats } from './stats.ts'
import { turns } from './turns.ts'
import { modelEffort } from './model-effort.ts'

// Records a slash command (origin: model for Hal, from for another session,
// otherwise the human) and
// runs it. `command`: the client's id for the submit. Returns why it is
// refused: no such command, or one only a client may run (a session may
// not quit or restart the user's terminal). A quiet command the human
// runs is recorded only if its reply shows something, such as an error.
function command(
	id: string,
	text: string,
	call: { name: string; args: string },
	command?: string,
	from?: string,
	completed?: (reply: Reply) => void,
	origin?: 'model',
	sender?: Sender,
): string | undefined {
	let hold = queueEdits.refused(id, call.name, call.args)
	if (hold) return hold
	if (commandList.byName(call.name)?.clientOnly) return `only a client can run /${call.name}`
	if (call.name === 'budget' && from !== undefined) return 'only a human can run /budget'
	let cmd = commands.all().get(call.name)
	if (!cmd) return `unknown command /${call.name} (/help lists them)`
	let shown = cmd.record?.(call.args, id)
	text = shown ?? text
	let typed = () => {
		if (shown === null) return
		let record: Omit<HistoryRecord & { type: 'command' }, 'ts'> = { type: 'command', text, ...(origin && { origin }) }
		if (from !== undefined) record.from = from
		if (sender?.label !== undefined) record.label = sender.label
		if (command !== undefined) record.command = command
		let { n, ts } = history.append(id, record)
		host.broadcast(id, {
			type: 'command',
			sessionId: id,
			text,
			...(origin && { origin }),
			...(from !== undefined && { from }),
			...(sender?.label !== undefined && { label: sender.label }),
			ts,
			n,
			...(command !== undefined && { command }),
			...slash.placed(id),
		})
	}
	if (cmd.quiet && from === undefined && !origin) {
		void (async () => {
			let reply: Reply
			try {
				reply = await slash.attempt(id, call.name, call.args, undefined, sender, command)
			} catch (e: any) {
				reply = { error: String(e?.message ?? e) }
			}
			if (Object.keys(reply).some((k) => k !== 'result')) {
				typed()
				reply = slash.report(id, call.name, call.args, reply, sender)
			}
			completed?.(reply)
		})()
		return
	}
	typed()
	void slash
		.runCommand(id, call.name, call.args, undefined, {
			...sender,
			...(from !== undefined && { from }),
			...(origin && { origin }),
		})
		.then((reply) => completed?.(reply))
}

// What a command runs with: its session, whose cwd and model it may
// change.
function context(id: string, sender?: Sender, command?: string): Context {
	let meta = sessions.open(id)
	return {
		sessionId: id,
		sender,
		command,
		cwd: meta.cwd,
		previousCwd: meta.previousCwd,
		model: meta.model,
		effort: meta.effort,
		setCwd: (cwd) => slash.change(id, { cwd }),
		setModel: (model) => slash.change(id, { model }, sender?.origin),
		setName: (name) => slash.name(id, name),
		say: (text) => slash.output(id, text, false, sender?.origin),
	}
}

// Changes the session's cwd or model: saved, told to followers, and
// recorded before hard steering active work. The next request rebuilds
// its system prompt from the new context; pause and tool safety stay intact.
function change(id: string, patch: { cwd?: string; model?: string }, origin?: 'model'): string | undefined {
	let meta = sessions.open(id)
	let previous = { cwd: meta.cwd, model: modelList.qualified(meta.model, meta.effort) }
	let changed: typeof patch = {}
	if (patch.cwd !== undefined && patch.cwd !== meta.cwd) changed.cwd = patch.cwd
	let selection = patch.model === undefined ? undefined : modelList.selection(patch.model)
	if (selection && (selection.id !== meta.model || selection.effort !== meta.effort))
		changed.model = modelList.qualified(selection.id, selection.effort)
	if (!Object.keys(changed).length) return
	let names = changed.model ? modelList.nameEvent([meta.model, selection!.id]) : undefined
	if (changed.cwd !== undefined) {
		meta.previousCwd = meta.cwd
		meta.cwd = changed.cwd
	}
	let switched = ''
	if (changed.model !== undefined && selection) {
		let describe = (id: string, qualified: string) =>
			names?.names[id] ? `${names.names[id]} (${qualified})` : qualified
		switched = `Switched from ${describe(meta.model, previous.model)} to ${describe(selection.id, changed.model)}.`
		meta.model = selection.id
		if (selection.effort === undefined) delete meta.effort
		else meta.effort = selection.effort
		// hal/tool runs what the user types: its calls show whole (task hyt).
		if (selection.id === 'hal/tool' && !meta.blocks?.tool) meta.blocks = { ...meta.blocks, tool: 'long' }
	}
	liveFiles.save(meta)
	history.append(id, { type: 'change', ...changed, previous })
	host.broadcast(
		id,
		changed.model === undefined
			? { type: 'meta', sessionId: id, meta: { ...meta } }
			: { type: 'meta', sessionId: id, meta: { ...meta }, stats: stats.of(id) },
	)
	if (switched) slash.output(id, switched, false, origin)
	let running = turns.state.running.get(id)
	let continuing = running?.controller.signal.aborted ? undefined : running
	let moved = changed.cwd === undefined ? '' : `Working directory changed from ${previous.cwd} to ${changed.cwd}.`
	let notice = [switched, moved].filter(Boolean).join(' ')
	if (continuing)
		notice +=
			' Continue your unfinished response using the current context, without repeating what you already wrote or completed.'
	history.append(id, { type: 'notice', text: notice })
	if (continuing) prompts.force(continuing)
	if (changed.model) {
		// A turn waiting out a failure tries the new model now.
		running?.rewait?.abort()
		if (names) host.broadcast(id, names)
	}
	return switched || undefined
}

// Session names change tab labels but not the model's working context.
function name(id: string, value?: string): void {
	naming.manual(id, value)
}
// Runs command `name` (again, with `answers`, once its question is
// answered) and records what it said.
async function runCommand(id: string, name: string, args: string, answers?: Answers, sender?: Sender): Promise<Reply> {
	let reply: Reply
	try {
		reply = await slash.attempt(id, name, args, answers, sender)
	} catch (e: any) {
		reply = { error: String(e?.message ?? e) }
	}
	return slash.report(id, name, args, reply, sender)
}

// Runs command `name`; a failure throws. `command`: the client's id.
function attempt(
	id: string,
	name: string,
	args: string,
	answers?: Answers,
	sender?: Sender,
	command?: string,
): Reply | Promise<Reply> {
	let cmd = commands.all().get(name)
	if (!cmd) throw new Error(`unknown command /${name}`)
	return cmd.run(args, answers, slash.context(id, sender, command))
}

// Records and tells what command `name` replied, and opens its question.
function report(id: string, name: string, args: string, reply: Reply, sender?: Sender): Reply {
	if (reply.say !== undefined) slash.output(id, reply.say, false, sender?.origin)
	if (reply.synthetic !== undefined) slash.output(id, reply.synthetic, false, undefined, true)
	if (reply.show !== undefined)
		host.broadcast(id, { type: 'output', sessionId: id, text: reply.show, ...slash.placed(id) })
	if (reply.error !== undefined) slash.output(id, reply.error, true, sender?.origin)
	if (reply.open === 'models') void slash.models(id).then((e) => host.broadcast(id, e))
	if (reply.open === 'settings') host.broadcast(id, { ...config.event(), sessionId: id })
	// The intro paused for this login (task vc): signed in, it goes on.
	if (
		name === 'login' &&
		!reply.ask &&
		!reply.error &&
		sessions.open(id).model === 'hal/intro' &&
		status.stateOf(id).type === 'paused'
	)
		prompts.resume(id)
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
	let { n, ts } = history.append(id, {
		type: 'question',
		id: question,
		form: reply.ask,
		from: { command: name, args: reply.askArgs ?? args },
	})
	host.broadcast(id, {
		type: 'question',
		sessionId: id,
		id: question,
		form: reply.ask,
		n,
		ts,
		command: true,
		...slash.placed(id),
	})
	return reply
}

// The model picker's content for session `id`.
async function models(id: string): Promise<Event & { type: 'models' }> {
	let event = await slash.listing(id)
	// Lists arriving while the picker is open update it in place (task 0x).
	void modelList.warm().then(async () => {
		let fresh = await slash.listing(id)
		if (fresh.items.join() !== event.items.join()) host.broadcast(id, { ...fresh, refresh: true })
	})
	return event
}

async function listing(id: string): Promise<Event & { type: 'models' }> {
	let current = sessions.open(id).model
	let items = await modelList.list(current)
	let capabilities = Object.fromEntries(
		items.flatMap((model) => {
			let cap = modelEffort.describe(model)
			return cap ? [[model, cap]] : []
		}),
	)
	return {
		type: 'models',
		sessionId: id,
		current,
		effort: sessions.open(id).effort,
		capabilities,
		items,
		names: modelList.names(items),
	}
}

// Closes question `question` unanswered: Escape, or a newer one
// replaces it. Whoever asked is not run again.
function dismiss(id: string, question: string): void {
	history.append(id, { type: 'answer', question, answers: {}, canceled: true })
	host.broadcast(id, { type: 'answer', sessionId: id, question, answers: {}, canceled: true })
}

// Queued message `item`, the `n`th, dropped: withdrawn, and a card that
// keeps its text, since a drop has no undo.
function drop(id: string, item: { id: string; text: string }, n: number): void {
	history.append(id, { type: 'inbox', id: item.id, text: item.text, withdrawn: true })
	slash.output(id, `Queue item #${n} was dropped: ${item.text}`, false, undefined, false, true)
}

// What a command said. `origin: model` marks a model-run command's
// outcome, which its tool card shows instead (task 9g).
function output(id: string, text: string, error = false, origin?: 'model', synthetic = false, notice = false): void {
	let { n, ts } = history.append(id, {
		type: 'output',
		text,
		...(error && { error: true as const }),
		...(origin && { origin }),
		...(synthetic && { synthetic: true }),
		...(notice && { notice: true }),
	})
	host.broadcast(id, {
		type: 'output',
		sessionId: id,
		text,
		...(error && { error: true as const }),
		...(origin && { origin }),
		...(synthetic && { synthetic: true }),
		...(notice && { notice: true }),
		n,
		ts,
		...slash.placed(id),
	})
}

// Where a command's record landed beside a running turn: before the
// block still streaming, if any (it is written when done), so clients
// fold it where history has it (task rk).
function placed(id: string): { streaming?: true } {
	return history.live(id)?.blocks.length ? { streaming: true } : {}
}

export const slash = {
	command,
	listing,
	context,
	change,
	name,
	runCommand,
	attempt,
	report,
	drop,
	models,
	dismiss,
	output,
	placed,
}

// A session falling back to a paid API key says so where the user reads.
auth.fallback = (id, text) => slash.output(id, text)
// So does a broken login, as an error.
auth.broke = (id, text) => slash.output(id, text, true)
