// The hal/plugin-sync review session (task b81), host side. /plugin-sync
// opens or focuses one review tab per client home and starts its turn.
// The scripted model relays each turn to that home's remote terminal,
// which holds the comparison (plugin-sync-client.ts): the terminal
// applies an answer, then sends a step saying what happened and what to
// ask next (plugin-sync-review.ts). Questions and answers stay ordinary
// durable forms in the session. Which home a session reviews is kept in
// memory: after a host restart, /plugin-sync binds it again. Escape
// aborts a wait; a terminal that goes away ends it with the reason.
// Tasks: b81.

import type { Answers, Form } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { clients } from './clients.ts'
import { host } from './host.ts'
import { pluginSync } from './plugin-sync.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import type { Reply } from './synthetic.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'

type Client = { deliver(event: Event): void }
type Step = { say: string; ask?: Form }

const MODEL = 'hal/plugin-sync'
const gone = 'The remote terminal reviewing plugins is not connected, so nothing was written here. Type /plugin-sync in it once it is connected to continue.'

// The review tab's name for client home `home`.
const nameFor = (home: string): string => `Plugin sync ${home.slice(0, 6)}`

// A connected terminal of `home`, `client` first.
function terminal(home: string, client?: Client): Client | undefined {
	let live = (c: Client) => host.state.clients.has(c as any) && pluginSync.state.followers.get(c) === home
	return client && live(client) ? client : [...pluginSync.state.followers.keys()].find(live)
}

// Asks the terminal for session `id`'s next step; undefined if Escape
// aborted the turn first.
function ask(id: string, home: string, client: Client, answers: Answers | undefined): Promise<Step | undefined> {
	let signal = turns.state.running.get(id)?.controller.signal
	return new Promise((resolve) => {
		let check = setInterval(() => terminal(home) || settle({ say: gone }), pluginSyncSession.checkMs)
		let settle = (s: Step | undefined) => {
			clearInterval(check)
			signal?.removeEventListener('abort', abort)
			pluginSyncSession.state.waiting.delete(id)
			resolve(s)
		}
		let abort = () => settle(undefined)
		signal?.addEventListener('abort', abort)
		pluginSyncSession.state.waiting.set(id, settle)
		client.deliver({ type: 'plugin-sync', review: id, ...(answers ? { answers } : {}) })
	})
}

// The scripted model: says the terminal's step at once (a diff is too
// long to type out) and asks its question.
function run(answers: Answers | undefined, id: string): Reply {
	let reply: Reply = {}
	reply.stream = (async function* () {
		let bound = pluginSyncSession.state.bound.get(id)
		let client = bound && terminal(bound.home, bound.client)
		let step = client ? await ask(id, bound!.home, client, answers) : { say: gone }
		if (!step) return
		if (step.ask) reply.ask = step.ask
		yield { type: 'text' as const, text: step.say }
		yield { type: 'done' as const, reason: 'end' as const }
	})()
	return reply
}

// A terminal's step for a waiting session; throws when none waits.
function step(c: { session: string; say: string; ask?: Form }): void {
	let settle = pluginSyncSession.state.waiting.get(c.session)
	if (!settle) throw new Error(`plugin sync: session ${c.session} is not waiting for a review step`)
	settle({ say: c.say, ...(c.ask ? { ask: c.ask } : {}) })
}

// The review tab for `name`: open, else reopened, else new after `after`.
function find(name: string, after: string, cwd: string): string {
	let ours = (id: string) => {
		try { let m = sessions.open(id); return m.model === MODEL && m.name === name } catch { return false }
	}
	let f = tabs.file()
	let id = f.open.find(ours)
	if (id) return id
	let closed = f.closed.find((c) => ours(c.id))?.id
	if (closed) tabs.resume(closed)
	else {
		id = sessions.create({ cwd, model: MODEL, name }).id
		let at = f.open.indexOf(after)
		tabs.insert(id, at < 0 ? f.open.length : at + 1)
	}
	tabs.publish()
	return closed ?? id!
}

// /plugin-sync typed in session `from`: binds the review tab to the
// typing terminal's home, focuses it there and starts it unless a turn
// or question is under way.
function open(from: string, cwd: string): { error?: string; say?: string } {
	let rec = clients.state.senders.get(from)
	let client = [...host.state.clients].find((c) => c.record === rec)
	let home = client && pluginSync.state.followers.get(client)
	if (!client || home === undefined) return { error: '/plugin-sync reviews portable plugins from a terminal started with ./run -r <host> on another Hal home; this client compares none with this host.' }
	if (home === pluginSync.home()) return { say: 'This terminal runs on the host\'s own home: there is nothing to compare.' }
	let id = find(nameFor(home), from, cwd)
	pluginSyncSession.state.bound.set(id, { home, client })
	let state = status.stateOf(id).type
	if ((state === 'idle' || state === 'paused' || state === 'error') && !status.transition(id, { type: 'submit' })) turns.start(id)
	if (id !== from) host.broadcast(from, { type: 'go', sessionId: from, tab: id })
	return {}
}

export const pluginSyncSession = {
	// `bound`: the home (and terminal) each review session serves;
	// `waiting`: settles a session's pending step.
	state: { bound: new Map<string, { home: string; client: Client }>(), waiting: new Map<string, (s: Step | undefined) => void>() },
	checkMs: 5000,
	MODEL,
	nameFor,
	terminal,
	ask,
	run,
	step,
	find,
	open,
}
