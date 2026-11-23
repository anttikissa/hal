// Tabs: which sessions are open as tabs, in order, for the whole home,
// kept in state/tabs.ason. Every client sees the same tabs; which one a
// client shows (focus) is its own business. Closing a tab pauses its turn
// and the turns it owns, rather than leaving work running unseen.
//
// The file holds the open ids in order, recently closed ids with the
// index they had (most recent last) and the tabs that want attention.
// Only the tabs' own sessions are ever read, never every session on disk.

import { mkdirSync } from 'fs'
import { resolve } from 'path'
import type { Command, Event, Tab } from '../common/protocol.ts'
import { forms } from '../common/forms.ts'
import { usage } from './usage.ts'
import { host } from './host.ts'
import { history } from './history.ts'
import { greetings } from './greetings.ts'
import { jobs } from './jobs.ts'
import { liveFiles } from './live-file.ts'
import { marksWorker } from './marks-worker.ts'
import { models } from './models.ts'
import { notify } from './notify.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { provider } from './provider.ts'
import { projects } from './projects.ts'
import { sessions, type SessionMeta } from './sessions.ts'
import { states } from '../common/states.ts'
import { subagents } from './subagents.ts'
import { turns } from './turns.ts'
import { status } from './status.ts'
import { projectContext } from './project-context.ts'
import { promptCache } from './prompt-cache.ts'

type TabsFile = { open: string[]; closed: { id: string; index: number }[]; attention: string[] }
export type TabCommand = Extract<Command, { type: `tab-${string}` }>
// What a tab command did: refused (why), or the tab it created, reopened
// or picked.
type Outcome = { refused?: string; tab?: string; reply?: Event }

// The tabs file, read from disk on first use. Throws if it is malformed;
// it is then left untouched and every tab command is refused.
function file(): TabsFile {
	if (tabs.state.file) return tabs.state.file
	let path = `${paths.stateDir()}/tabs.ason`
	mkdirSync(paths.stateDir(), { recursive: true })
	let data = liveFiles.liveFile<TabsFile>(path, { open: [], closed: [], attention: [] }, { watch: false })
	if (![data.open, data.closed, data.attention].every(Array.isArray)) {
		liveFiles.close(data)
		throw new Error(`${path}: open, closed and attention must be lists`)
	}
	// Closed tabs want nothing; older files kept their marks.
	let open = new Set(data.open)
	if (data.attention.some((id) => !open.has(id))) data.attention = data.attention.filter((id) => open.has(id))
	return (tabs.state.file = data)
}

// Every tab as the tab bar shows it. A tab whose session can't be read
// stays, failed with the reader's error, rather than failing the rest.
function list(): Tab[] {
	let f = tabs.file()
	// Plain copies: each read of the live-file proxy goes through a trap,
	// and lookups per tab made 275 tabs cost 130 ms (task 7j).
	let open = [...f.open]
	let shown = new Set(open)
	let attention = new Set(f.attention)
	let untrusted = new Map<string, boolean>()
	for (let id of questions.keys()) if (!shown.has(id)) questions.delete(id)
	let list = open.map((id) => row(id, attention, untrusted))
	projects.paint(list)
	return list
}

// One tab without its project color; `untrusted` caches trust per cwd.
function row(id: string, attention: Set<string>, untrusted: Map<string, boolean>): Tab {
	let meta: SessionMeta
	try {
		meta = sessions.open(id)
	} catch (e: any) {
		return { id, name: id, cwd: '', model: '', state: { type: 'error', message: String(e?.message ?? e) } }
	}
	let tab: Tab = { id, name: meta.name ?? id, cwd: meta.cwd, model: meta.model, state: stateOf(id) }
	if (tab.state.type !== 'error') {
		try {
			let question = questionOf(id)
			if (question) tab.question = question
		} catch (e: any) {
			tab.state = { type: 'error', message: String(e?.message ?? e) }
		}
	}
	if (attention.has(id)) tab.attention = true
	if (meta.background?.length) tab.jobs = meta.background.length
	if (meta.cwd.replace(/\/+$/, '') === paths.repoRoot()) tab.hal = true
	let trust = `${meta.cwd}\0${meta.projectTrust}`
	if (!untrusted.has(trust)) untrusted.set(trust, projectContext.skipped(meta.cwd, meta.projectTrust).length > 0)
	if (untrusted.get(trust)) tab.untrusted = true
	return tab
}

// Each tab's id and project color, as list() gives them, without its
// state: what a close notice needs, at a fraction of list()'s cost.
function places(): { id: string; cwd: string; color?: number }[] {
	let list = [...tabs.file().open].map((id) => {
		try {
			return { id, cwd: sessions.open(id).cwd }
		} catch {
			return { id, cwd: '' }
		}
	})
	projects.paint(list as Tab[])
	return list
}

const questions = new Map<string, { size: number; question: Tab['question'] }>()

function questionOf(id: string): Tab['question'] {
	let size = pages.marks(id).size
	let cached = questions.get(id)
	if (cached?.size === size) return cached.question
	let open = forms.open(pages.essentials(id))
	let question: Tab['question'] = open
		? open.call
			? 'approval'
			: 'ordinary'
		: notify.asked(id)
			? 'ordinary'
			: undefined
	questions.set(id, { size, question })
	return question
}

// Sends the tabs, then the model names they show, to a new client
// (host.connect) while `live`.
function greet(client: { deliver: (event: Event) => void }, live: () => boolean): void {
	try {
		let openTabs = tabs.list()
		client.deliver({ type: 'tabs', tabs: openTabs, sessions: sessions.ids(), subscriptions: usage.snapshot() })
		queueMicrotask(() => {
			if (!live()) return
			try {
				let names = models.nameEvent(openTabs.map((tab) => tab.model))
				if (names) client.deliver(names)
			} catch (e: any) {
				client.deliver({ type: 'warning', text: String(e?.message ?? e) })
			}
		})
	} catch (e: any) {
		client.deliver({ type: 'warning', text: String(e?.message ?? e) })
	}
}

// Works out the open tabs' states from their marks, caught up first, in
// slices (pages.slices): undefined when done at once, else a promise,
// never rejected (an unreadable history fails its tab in list()).
function indexed(): Promise<void> | undefined {
	let open: string[] = []
	try {
		open = tabs.file().open
	} catch {}
	let steps = (): void | Promise<void> =>
		pages.slices(
			(function* () {
				let n = 0
				for (let id of open) {
					try {
						// Its meta too, which the tabs event reads.
						sessions.open(id)
						status.derive(
							id,
							(yield* pages.markedSteps(id)).map((l) => l.record),
						)
					} catch {}
					// Every 8th tab counts as a big read, so 60 small ones yield
					// between slices (task 7j); a few still finish at once.
					yield ++n % 8 ? 0 : pages.syncBytes
				}
			})(),
		)
	// Old marks convert in a worker first (task 7j).
	let upgraded = marksWorker.upgrade(open)
	let done = upgraded ? upgraded.then(steps) : steps()
	return done instanceof Promise ? done : undefined
}

// A session whose history cannot be read stays in the tab bar, failed
// with the reader's error (path and record), so it is seen, never
// skipped; opening it is refused with the same error.
function stateOf(id: string): Tab['state'] {
	try {
		return status.stateOf(id)
	} catch (e: any) {
		return { type: 'error', message: String(e?.message ?? e) }
	}
}

// A session as people and models tell it apart: tab, id and name.
function label(id: string): string {
	let tab = tabs.file().open.indexOf(id)
	let name = sessions.open(id).name
	return [...(tab < 0 ? [] : [`tab ${tab + 1}`]), id, ...(name ? [name] : [])].join(' · ')
}

// Writes the change and tells every client.
function publish(): void {
	liveFiles.save(tabs.file())
	let list = tabs.list()
	tabs.state.rows = new Map(list.map((t) => [t.id, t]))
	let event: Event = { type: 'tabs', tabs: list }
	for (let client of host.state.clients) client.deliver(event)
}

// Tells every client one tab's new row, if it changed. Its project color
// stays: a cwd change publishes every tab.
function update(id: string): void {
	let f = tabs.file()
	let before = tabs.state.rows.get(id)
	if (!before) return tabs.publish()
	let tab = row(id, new Set(f.attention), new Map())
	if (before.color !== undefined) tab.color = before.color
	if (JSON.stringify(tab) === JSON.stringify(before)) return
	tabs.state.rows.set(id, tab)
	liveFiles.save(f)
	let event: Event = { type: 'tab', tab }
	for (let client of host.state.clients) client.deliver(event)
}

// Tells every client where tab `id` now sits (opened, reopened, moved).
// Joining a project that has open tabs, it takes their color; a new
// project can recolor every tab, so then all of them go.
function place(id: string): void {
	let f = tabs.file()
	let tab = row(id, new Set(f.attention), new Map())
	let peer = [...tabs.state.rows.values()].find((t) => t.id !== id && t.cwd === tab.cwd)
	if (!peer) return tabs.publish()
	if (peer.color !== undefined) tab.color = peer.color
	tabs.state.rows.set(id, tab)
	liveFiles.save(f)
	let event: Event = { type: 'tab', tab, index: f.open.indexOf(id) }
	for (let client of host.state.clients) client.deliver(event)
}

// Tells every client tab `id` closed; the last tab of a project can
// recolor the rest, so then all of them go.
function drop(id: string): void {
	let rows = tabs.state.rows
	let cwd = rows.get(id)?.cwd
	rows.delete(id)
	if (![...rows.values()].some((t) => t.cwd === cwd)) return tabs.publish()
	liveFiles.save(tabs.file())
	let event: Event = { type: 'tab-gone', id }
	for (let client of host.state.clients) client.deliver(event)
}

function insert(id: string, index: number): void {
	let open = tabs.file().open
	open.splice(Math.max(0, Math.min(open.length, index)), 0, id)
	projectContext.changed(id)
}

function create(
	cwd: string,
	after?: string,
	autoclose = false,
	interactive = true,
	timezone?: string,
	trust?: boolean,
	systemPrompt?: string,
): string {
	// A tab on hal/intro (the default model until config.ason sets one) is
	// the welcome guide, which speaks first: no prompt needed to start it.
	let open = tabs.file().open
	let at = after === undefined ? -1 : open.indexOf(after)
	let parent = at < 0 ? undefined : sessions.open(after!)
	// A new tab opened from a hal/sync tab uses the default model.
	// Tested once, then the tests were deleted. If you change this code, first write tests for: Ctrl-T from a hal/sync tab.
	let model = parent && parent.model !== 'hal/sync' ? models.qualified(parent.model, parent.effort) : undefined
	let intro = interactive && (model ?? models.defaultModel()) === 'hal/intro'
	let dir = parent?.cwd ?? cwd
	let projectTrust = trust === undefined ? undefined : trust && projectContext.root(dir)
	let id = sessions.create({ cwd: dir, autoclose, interactive, projectTrust, systemPrompt, ...(model && { model }) }).id
	if (!intro) greetings.open(id, timezone)
	tabs.insert(id, at < 0 ? open.length : at + 1)
	if (intro && !status.transition(id, { type: 'submit' })) turns.start(id)
	return id
}

// A child is owned only while doing its parent's work; a human's later
// prompt in a leave-open subagent belongs to the human, not its parent.
function stopOwned(id: string): void {
	for (let child of sessions.openIds()) {
		let meta = sessions.open(child)
		if (meta.parent === id && meta.spawn !== 'interactive' && subagents.owed(child, history.readSync(child)))
			tabs.stopOwned(child)
	}
	jobs.kill(id)
	for (let name of Object.keys(provider.state.providers)) {
		let desc = Object.getOwnPropertyDescriptor(provider.state.providers, name)
		if (desc && 'value' in desc) (desc.value as { stop?(id: string): void })?.stop?.(id)
	}
	if (states.busy(status.stateOf(id))) {
		let refused = turns.stop(id, 'tab closed', true)
		if (refused) throw new Error(`cannot stop ${id}: ${refused}`)
	}
}

function close(id: string): string | undefined {
	let f = tabs.file()
	let index = f.open.indexOf(id)
	if (index < 0) return 'not a tab'
	if (f.open.length === 1) return 'cannot close the last tab'
	tabs.stopOwned(id)
	let meta = sessions.open(id)
	meta.closedAt = new Date().toISOString()
	liveFiles.save(meta)
	f.open.splice(index, 1)
	let closed = f.closed.filter((c) => c.id !== id)
	closed.push({ id, index })
	f.closed = closed.slice(-tabs.closedKept)
	f.attention = f.attention.filter((x) => x !== id)
	projectContext.changed()
	return undefined
}

function resume(id?: string): Outcome {
	let f = tabs.file()
	if (id !== undefined && f.open.includes(id)) return { tab: id }
	let entry = id === undefined ? f.closed.at(-1) : (f.closed.find((c) => c.id === id) ?? { id, index: f.open.length })
	if (!entry) return { refused: 'no closed tab to reopen' }
	sessions.open(entry.id) // throws if there is no such session
	f.closed = f.closed.filter((c) => c.id !== entry.id)
	tabs.insert(entry.id, entry.index)
	return { tab: entry.id }
}

// The user closed its tab and nobody reopened it; a session that never
// had a tab is not closed.
function closed(id: string): boolean {
	return !tabs.file().open.includes(id) && sessions.open(id).closedAt !== undefined
}

function start(cwd?: string, last?: string, timezone?: string): Outcome {
	let open = tabs.file().open
	// An unreadable session is in no cwd; list() shows it failed.
	let inCwd = (id: string) => {
		if (cwd === undefined) return true
		try {
			return resolve(sessions.open(id).cwd) === resolve(cwd)
		} catch {
			return false
		}
	}
	let found = last !== undefined && open.includes(last) && inCwd(last) ? last : open.find(inCwd)
	return found ? { tab: found } : { tab: tabs.create(cwd ?? host.cwd(), undefined, false, true, timezone) }
}

function is(c: Command): c is TabCommand {
	return c.type.startsWith('tab-')
}

// Carries out a tab command; a change goes to every client.
function act(c: TabCommand, timezone?: string): Outcome {
	let f = tabs.file()
	// A turn that asked keeps its mark until the user sends something (task nd6);
	// a tab marked by /unread keeps it until its client shows another (task wr5).
	// Clients send this on every tab list while the shown tab is marked.
	if (c.type === 'tab-seen') {
		let id = c.sessionId
		if (!f.attention.includes(id) || notify.asked(id) || tabs.state.kept.has(id)) return {}
		f.attention = f.attention.filter((x) => x !== id)
		tabs.update(id)
		return {}
	}
	let order = f.open.join('\n')
	let outcome: Outcome = {}
	if (c.type === 'tab-new') {
		let tab = tabs.create(c.cwd, c.after, c.autoclose, c.interactive, timezone, c.trust, c.systemPrompt)
		let text = c.interactive === false ? projectContext.report(tab, c.trust) : undefined
		outcome = { tab, ...(text && { reply: { type: 'warning', text } as const }) }
	} else if (c.type === 'tab-close') {
		outcome = { refused: tabs.close(c.sessionId) }
		if (outcome.refused === undefined) tabs.drop(c.sessionId)
		return outcome
	} else if (c.type === 'tab-resume') outcome = tabs.resume(c.sessionId)
	else if (c.type === 'tab-start') outcome = tabs.start(c.cwd, c.last, timezone)
	else if (c.type === 'tab-move') {
		let from = f.open.indexOf(c.sessionId)
		if (from < 0) return { refused: 'not a tab' }
		f.open.splice(from, 1)
		tabs.insert(c.sessionId, c.index)
		tabs.place(c.sessionId)
		return outcome
	}
	if (outcome.tab !== undefined && f.open.join('\n') !== order) tabs.place(outcome.tab)
	return outcome
}

// Hears every session event (host.broadcast): a tab wants attention when
// its turn ends or fails or asks a question, unless a script drives it
// (nobody would read the mark), and the tab bar shows its state and name.
function observe(id: string, event: Event): void {
	if (!['state', 'turn-start', 'prompt', 'turn-end', 'question', 'answer', 'meta'].includes(event.type)) return
	let f: TabsFile
	try {
		f = tabs.file()
	} catch {
		return
	}
	if (!f.open.includes(id)) return
	let wants =
		event.type === 'question' ||
		(event.type === 'turn-end' && (event.status === 'completed' || event.status === 'error'))
	if (wants && !f.attention.includes(id) && promptCache.interactive(id)) f.attention.push(id)
	// The user answered an asking turn: a new turn runs.
	if (event.type === 'state' && states.busy(event.state)) {
		tabs.state.kept.delete(id)
		if (f.attention.includes(id)) f.attention = f.attention.filter((x) => x !== id)
	}
	// A new cwd can recolor other tabs of its project and change its plugins.
	if (event.type === 'meta' && event.meta.cwd !== tabs.state.rows.get(id)?.cwd) {
		projectContext.changed()
		tabs.publish()
	} else tabs.update(id)
}

// Marks tabs unread (/unread). `shown`, the tab the command ran in, keeps
// its mark while its client still shows it.
function unread(ids: string[], shown?: string): void {
	let f = tabs.file()
	for (let id of ids) if (!f.attention.includes(id)) f.attention.push(id)
	if (shown !== undefined && ids.includes(shown)) tabs.state.kept.add(shown)
	tabs.publish()
}

// A client stopped showing `id`: showing it again clears an /unread mark.
function left(id: string): void {
	tabs.state.kept.delete(id)
}

// Forgets the loaded file, writing pending changes (tests, restart).
function reset(): void {
	if (tabs.state.file) liveFiles.close(tabs.state.file)
	tabs.state.file = null
	tabs.state.kept.clear()
	tabs.state.rows.clear()
	questions.clear()
}

export const tabs = {
	// kept: tabs /unread marked while shown, whose tab-seen is ignored.
	// rows: each tab as clients last heard it.
	state: { file: null as TabsFile | null, kept: new Set<string>(), rows: new Map<string, Tab>() },
	// How many recently closed tabs are remembered.
	closedKept: 50,
	file,
	is,
	list,
	places,
	greet,
	indexed,
	label,
	publish,
	insert,
	create,
	stopOwned,
	close,
	resume,
	closed,
	start,
	act,
	update,
	place,
	drop,
	observe,
	unread,
	left,
	reset,
}
