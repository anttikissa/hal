// Tabs: which sessions are open as tabs, in order, for the whole home,
// kept in state/tabs.ason. Every client sees the same tabs; which one a
// client shows (focus) is its own business. Tabs are not following: a
// client follows a session with open/close (host.ts), and closing a tab
// leaves the session and any running turn going.
//
// The file holds the open ids in order, recently closed ids with the
// index they had (most recent last) and the tabs that want attention.
// Only the tabs' own sessions are ever read, never every session on disk.

import { mkdirSync } from 'fs'
import { resolve } from 'path'
import type { Command, Event, Tab } from '../common/protocol.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
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
	return f.open.flatMap((id) => {
		try {
			let meta = sessions.open(id)
			let tab: Tab = { id, name: meta.name ?? id, cwd: meta.cwd, model: meta.model, state: status.stateOf(id) }
			if (f.attention.includes(id)) tab.attention = true
			if (meta.cwd.replace(/\/+$/, '') === paths.repoRoot()) tab.hal = true
			return [tab]
		} catch {
			return []
		}
	})
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
	let id = sessions.create({ cwd }).id
	let open = tabs.file().open
	let at = after === undefined ? -1 : open.indexOf(after)
	tabs.insert(id, at < 0 ? open.length : at + 1)
	return id
}

function close(id: string): string | undefined {
	let f = tabs.file()
	let index = f.open.indexOf(id)
	if (index < 0) return 'not a tab'
	if (f.open.length === 1) return 'cannot close the last tab'
	f.open.splice(index, 1)
	let closed = f.closed.filter((c) => c.id !== id)
	closed.push({ id, index })
	f.closed = closed.slice(-tabs.closedKept())
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
	let inCwd = (id: string) => {
		if (cwd === undefined) return true
		try {
			return resolve(sessions.open(id).cwd) === resolve(cwd)
		} catch {
			return false
		}
	}
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
	closedKept: () => 50,
	file,
	is,
	list,
	label,
	publish,
	insert,
	create,
	close,
	resume,
	start,
	act,
	observe,
	reset,
}
