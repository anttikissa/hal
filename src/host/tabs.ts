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
import { host } from './host.ts'
import { history } from './history.ts'
import { greetings } from './greetings.ts'
import { jobs } from './jobs.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { projects } from './projects.ts'
import { sessions } from './sessions.ts'
import { states } from '../common/states.ts'
import { subagents } from './subagents.ts'
import { turns } from './turns.ts'
import { status } from './status.ts'

type TabsFile = { open: string[]; closed: { id: string; index: number }[]; attention: string[] }
export type TabCommand = Extract<Command, { type: `tab-${string}` }>
// What a tab command did: refused (why), or the tab it created, reopened
// or picked.
type Outcome = { refused?: string; tab?: string }

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
	return (tabs.state.file = data)
}

// Every tab as the tab bar shows it. A tab whose session can't be read
// is left out rather than failing the rest.
function list(): Tab[] {
	let f = tabs.file()
	let list = f.open.map((id) => {
		let meta = sessions.open(id)
		let tab: Tab = { id, name: meta.name ?? id, cwd: meta.cwd, model: meta.model, state: stateOf(id) }
		if (f.attention.includes(id)) tab.attention = true
		if (meta.cwd.replace(/\/+$/, '') === paths.repoRoot()) tab.hal = true
		return tab
	})
	projects.paint(list)
	return list
}

// Sends the tabs, then the model names they show, to a new client
// (host.connect) while `live`.
function greet(client: { deliver: (event: Event) => void }, live: () => boolean): void {
	try {
		let openTabs = tabs.list()
		client.deliver({ type: 'tabs', tabs: openTabs })
		queueMicrotask(() => {
			if (!live()) return
			try {
				let names = models.names(openTabs.map((tab) => tab.model))
				if (Object.keys(names).length) client.deliver({ type: 'model-names', names })
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
	let done = pages.slices(
		(function* () {
			for (let id of open) {
				try {
					status.derive(id, (yield* pages.markedSteps(id)).map((l) => l.record))
				} catch {}
				// Each tab costs as much as a big read: 60 small ones at once
				// blocked the event loop for ~100 ms (task 7j).
				yield pages.syncBytes
			}
		})(),
	)
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
	let event: Event = { type: 'tabs', tabs: tabs.list() }
	for (let client of host.state.clients) client.deliver(event)
}

function insert(id: string, index: number): void {
	let open = tabs.file().open
	open.splice(Math.max(0, Math.min(open.length, index)), 0, id)
}

function create(cwd: string, after?: string): string {
	// The very first tab of a fresh home is the offline welcome guide.
	let first = tabs.file().open.length === 0 && !sessions.newest()
	let open = tabs.file().open
	let at = after === undefined ? -1 : open.indexOf(after)
	let parent = at < 0 ? undefined : sessions.open(after!)
	let id = sessions.create({
		cwd: parent?.cwd ?? cwd,
		...(first ? { model: 'hal/intro' } : parent ? { model: models.qualified(parent.model, parent.effort) } : {}),
	}).id
	greetings.open(id)
	tabs.insert(id, at < 0 ? open.length : at + 1)
	// The guide speaks first: no prompt needed to start it.
	if (first && !status.transition(id, { type: 'submit' })) turns.start(id)
	return id
}

// A child is owned only while doing its parent's work; a human's later
// prompt in a leave-open subagent belongs to the human, not its old parent.
function stopOwned(id: string): void {
	for (let child of sessions.openIds()) {
		let meta = sessions.open(child)
		if (meta.parent === id && meta.spawn !== 'interactive' && subagents.owed(child, history.readSync(child))) tabs.stopOwned(child)
	}
	jobs.kill(id)
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

function start(cwd?: string, last?: string): Outcome {
	let open = tabs.file().open
	let inCwd = (id: string) => cwd === undefined || resolve(sessions.open(id).cwd) === resolve(cwd)
	let found = last !== undefined && open.includes(last) && inCwd(last) ? last : open.find(inCwd)
	return found ? { tab: found } : { tab: tabs.create(cwd ?? host.cwd()) }
}

function is(c: Command): c is TabCommand {
	return c.type.startsWith('tab-')
}

// Carries out a tab command; a change goes to every client.
function act(c: TabCommand): Outcome {
	let f = tabs.file()
	let before = JSON.stringify(f)
	let outcome: Outcome = {}
	if (c.type === 'tab-new') outcome = { tab: tabs.create(c.cwd, c.after) }
	else if (c.type === 'tab-close') outcome = { refused: tabs.close(c.sessionId) }
	else if (c.type === 'tab-resume') outcome = tabs.resume(c.sessionId)
	else if (c.type === 'tab-start') outcome = tabs.start(c.cwd, c.last)
	else if (c.type === 'tab-seen') f.attention = f.attention.filter((id) => id !== c.sessionId)
	else if (c.type === 'tab-move') {
		let from = f.open.indexOf(c.sessionId)
		if (from < 0) return { refused: 'not a tab' }
		f.open.splice(from, 1)
		tabs.insert(c.sessionId, c.index)
	}
	if (outcome.refused !== undefined) return outcome
	if (JSON.stringify(tabs.file()) !== before) tabs.publish()
	return outcome
}

// Hears every session event (host.broadcast): a tab wants attention when
// its turn ends or fails or asks a question, and the tab bar shows its
// state and name.
function observe(id: string, event: Event): void {
	if (!['state', 'turn-end', 'question', 'meta'].includes(event.type)) return
	let f: TabsFile
	try {
		f = tabs.file()
	} catch {
		return
	}
	if (!f.open.includes(id)) return
	let wants = event.type === 'question' || (event.type === 'turn-end' && (event.status === 'completed' || event.status === 'error'))
	if (wants && !f.attention.includes(id)) f.attention.push(id)
	tabs.publish()
}

// Forgets the loaded file, writing pending changes (tests, restart).
function reset(): void {
	if (tabs.state.file) liveFiles.close(tabs.state.file)
	tabs.state.file = null
}

export const tabs = {
	state: { file: null as TabsFile | null },
	// How many recently closed tabs are remembered.
	closedKept: 50,
	file,
	is,
	list,
	greet,
	indexed,
	label,
	publish,
	insert,
	create,
	stopOwned,
	close,
	resume,
	start,
	act,
	observe,
	reset,
}
