// Plugin sync, the comparing side (task zh7): a terminal started with
// `./run -r <host>` compares this home's portable plugins with the
// host's after connecting, in the background, so the prompt never waits.
// It asks for the host's heads, then history only for files whose
// contents differ, and works out from ancestry whether each differing
// file is client-ahead, server-ahead, divergent or unrelated. Nothing
// is written until apply() gets a confirmed choice; timestamps only
// suggest one. /plugin-sync (task b81) reads state and calls compare,
// diff, apply and ignore; onChange tells it the comparison changed.
//
// Comparisons never overlap: one asked for while another runs follows
// it. Requests go through the connection, so one sent while
// disconnected waits for the next connection; a fresh apply refuses
// while disconnected instead.
// Tasks: zh7.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { connection, type LinkState } from '../common/connection.ts'
import { pluginSyncWire, type PluginSyncCommand, type PluginSyncEvent, type SyncHead, type SyncVersion } from '../common/plugin-sync.ts'
import type { Event } from '../common/protocol.ts'
import { pluginHistory } from './plugin-history.ts'
import { pluginReports } from './plugin-reports.ts'
import { pluginSync } from './plugin-sync.ts'
import { textDiff } from './text-diff.ts'

export type Relation = 'client-ahead' | 'server-ahead' | 'divergent' | 'unrelated'
// missing: no history of the file on that side; deleted: a recorded
// deletion; empty: a zero-byte file.
export type SideInfo = { id?: string; hash?: string; ts?: string; status: 'present' | 'empty' | 'deleted' | 'missing'; offline?: true }
// `suggest`: the side with the later recorded time, when both have one
// and they differ.
export type Discrepancy = { file: string; relation: Relation; client: SideInfo; server: SideInfo; suggest?: 'client' | 'server' }
export type Excluded = { file: string; by: 'client' | 'server' | 'both' }
export type Choice = 'client' | 'server'
export type Expected = { client?: string; server?: string }

// The comparison was out of date; a revised one is in state now.
export class StaleError extends Error {}

const EMPTY = pluginSync.sha('')

function createState() {
	return {
		active: false,
		connected: false,
		// The host name, for notices and messages.
		name: '',
		// The host is this home: nothing to compare.
		same: false,
		running: false,
		again: false,
		timer: undefined as Timer | undefined,
		requests: new Map<string, { resolve(e: PluginSyncEvent): void; reject(e: Error): void }>(),
		discrepancies: [] as Discrepancy[],
		excluded: [] as Excluded[],
		// Versions the host sent for differing files, by file.
		server: new Map<string, SyncVersion[]>(),
		// Why the last comparison failed, complete.
		error: undefined as string | undefined,
		// When the last comparison finished (ISO).
		at: undefined as string | undefined,
	}
}

// Starts comparing with host `name` on every connection.
function start(name: string): void {
	pluginSyncClient.state = { ...createState(), active: true, name }
	pluginSync.onLocal = () => pluginSyncClient.schedule()
}

function link(s: LinkState): void {
	let st = pluginSyncClient.state
	st.connected = s.type === 'connected'
	if (st.connected) pluginSyncClient.schedule(0)
	pluginSyncClient.onChange()
}

// Takes an event meant for plugin sync; false if it is not one.
function event(e: Event): boolean {
	let reqs = pluginSyncClient.state.requests
	if (e.type === 'plugin-sync') {
		if (e.changed) pluginSyncClient.schedule()
		else if (e.request) reqs.get(e.request)?.resolve(e)
		return true
	}
	if ((e.type === 'ack' || e.type === 'rejected') && e.id !== undefined && reqs.has(e.id)) {
		if (e.type === 'rejected') reqs.get(e.id)!.reject(new Error(`${pluginSyncClient.state.name} refused plugin sync: ${e.reason}`))
		reqs.delete(e.id)
		return true
	}
	return false
}

// Sends `c` and waits for its answer, however many reconnects it takes.
function request(c: PluginSyncCommand): Promise<PluginSyncEvent> {
	let id = connection.nextId()
	return new Promise((resolve, reject) => {
		pluginSyncClient.state.requests.set(id, { resolve, reject })
		pluginSyncClient.send({ ...c, id })
	})
}

function schedule(ms = pluginSyncClient.debounceMs): void {
	let st = pluginSyncClient.state
	if (!st.active) return
	clearTimeout(st.timer)
	st.timer = setTimeout(() => void pluginSyncClient.compare(), ms)
	st.timer.unref?.()
}

// Compares now, or after the comparison already running.
async function compare(): Promise<void> {
	let st = pluginSyncClient.state
	if (st.running) return void (st.again = true)
	st.running = true
	try {
		await pluginSyncClient.run()
		st.error = undefined
	} catch (e: any) {
		st.error = `plugin sync with ${st.name}: ${e?.stack ?? e}`
		pluginReports.deliver({ type: 'warning', text: st.error })
	} finally {
		st.running = false
		st.at = new Date().toISOString()
	}
	pluginSyncClient.onChange()
	if (st.again) {
		st.again = false
		await pluginSyncClient.compare()
	}
}

function side(h: SyncHead | undefined): SideInfo {
	if (!h?.id) return { status: 'missing' }
	let status: SideInfo['status'] = h.deleted ? 'deleted' : h.hash === EMPTY ? 'empty' : 'present'
	return { id: h.id, ts: h.ts!, status, ...(h.hash ? { hash: h.hash } : {}), ...(h.offline ? { offline: true as const } : {}) }
}

const absent = (h: SyncHead) => !h.id || !!h.deleted

// How the two heads of a differing file relate through ancestry.
function relation(c: SyncHead, s: SyncHead, theirs: SyncVersion[]): Relation {
	if (!s.id) return 'client-ahead'
	if (!c.id) return 'server-ahead'
	let parents = new Map<string, string | undefined>()
	for (let v of pluginHistory.state.versions.values()) parents.set(v.id, v.parent)
	for (let v of theirs) parents.set(v.id, v.parent)
	let line = (id: string) => {
		let seen = new Set<string>()
		for (let at: string | undefined = id; at && !seen.has(at); at = parents.get(at)) seen.add(at)
		return seen
	}
	let mine = line(c.id), other = line(s.id)
	if (mine.has(s.id)) return 'client-ahead'
	if (other.has(c.id)) return 'server-ahead'
	return [...mine].some((id) => other.has(id)) ? 'divergent' : 'unrelated'
}

// One comparison: heads, then history for files whose contents differ.
async function run(): Promise<void> {
	let st = pluginSyncClient.state
	let ignore = new Set(pluginSync.ignored())
	let mine = pluginSync.portable()
	let inv = await pluginSyncClient.request({ type: 'plugin-sync', op: 'inventory', home: pluginSync.home(), names: mine.filter((n) => !ignore.has(n)) })
	st.same = inv.home === pluginSync.home()
	if (st.same) return void ((st.discrepancies = []), (st.excluded = []))
	let theirs = new Map((inv.heads ?? []).map((h) => [h.file, h]))
	let ignoredThere = new Set(inv.ignored ?? [])
	let names = [...new Set([...mine, ...theirs.keys()])].sort()
	st.excluded = names.flatMap((file): Excluded[] => {
		let here = ignore.has(file), there = ignoredThere.has(file)
		return here || there ? [{ file, by: here && there ? 'both' : here ? 'client' : 'server' }] : []
	})
	let differ = names.filter((f) => {
		if (ignore.has(f) || ignoredThere.has(f)) return false
		let c = pluginSync.headOf(f), s = theirs.get(f) ?? { file: f }
		return absent(c) && absent(s) ? false : c.hash !== s.hash || absent(c) !== absent(s)
	})
	let versions = differ.length ? ((await pluginSyncClient.request({ type: 'plugin-sync', op: 'history', files: differ })).versions ?? []) : []
	st.server = new Map(differ.map((f) => [f, versions.filter((v) => v.file === f)]))
	st.discrepancies = differ.map((file) => {
		let c = pluginSync.headOf(file), s = theirs.get(file) ?? { file }
		let d: Discrepancy = { file, relation: pluginSyncClient.relation(c, s, st.server.get(file)!), client: side(c), server: side(s) }
		if (c.ts && s.ts && c.ts !== s.ts) d.suggest = c.ts > s.ts ? 'client' : 'server'
		return d
	})
}

function find(file: string): Discrepancy {
	let d = pluginSyncClient.state.discrepancies.find((x) => x.file === file)
	if (!d) throw new Error(`plugin sync: ${file} does not differ from ${pluginSyncClient.state.name}`)
	return d
}

// Both texts of a differing file (undefined: missing or deleted) and a
// diff from the server's version (-) to the client's (+).
async function diff(file: string): Promise<{ client?: string; server?: string; diff: string }> {
	let d = pluginSyncClient.find(file)
	let client = d.client.hash ? pluginHistory.content(d.client.hash).toString('utf8') : undefined
	let server: string | undefined
	if (d.server.hash) {
		let got = (await pluginSyncClient.request({ type: 'plugin-sync', op: 'content', hashes: [d.server.hash] })).contents?.[d.server.hash]
		if (got === undefined) throw new Error(`plugin sync: ${pluginSyncClient.state.name} did not send ${file} (${d.server.hash})`)
		server = Buffer.from(got, 'base64').toString('utf8')
	}
	return { ...(client !== undefined ? { client } : {}), ...(server !== undefined ? { server } : {}), diff: textDiff.text(server ?? '', client ?? '') }
}

async function stale(file: string, where: Choice): Promise<never> {
	await pluginSyncClient.compare()
	throw new StaleError(`${file} changed on the ${where} since it was compared; nothing was written. Review the revised comparison.`)
}

// Makes `choice`'s version of `file` the other side's, if both heads
// are still `expected` (the compared ids); else refreshes and throws
// StaleError. Resolves once the destination has applied it.
async function apply(file: string, choice: Choice, expected: Expected): Promise<void> {
	let st = pluginSyncClient.state
	if (!pluginSyncWire.isName(file)) throw new Error(`plugin sync: not a plugin filename: ${file}`)
	if (!st.connected) throw new Error(`plugin sync: not connected to ${st.name}; nothing was written. Try again once it reconnects.`)
	let mineNow = () => pluginSync.headOf(file).id
	if (mineNow() !== expected.client) return pluginSyncClient.stale(file, 'client')
	if (choice === 'server') {
		let known = pluginSync.versionsOf(file).map((v) => v.id)
		let r = await pluginSyncClient.request({ type: 'plugin-sync', op: 'fetch', file, known, ...(expected.server ? { expect: expected.server } : {}) })
		if (r.stale) return pluginSyncClient.stale(file, 'server')
		if (mineNow() !== expected.client) return pluginSyncClient.stale(file, 'client')
		pluginSync.install(file, r.versions ?? [], r.contents ?? {}, expected.server, `server ${st.name}`, 'client')
	} else {
		let sent = new Set((st.server.get(file) ?? []).map((v) => v.id))
		let versions = pluginSync.versionsOf(file).filter((v) => !sent.has(v.id))
		let contents = Object.fromEntries(versions.flatMap((v) => (v.hash ? [[v.hash, pluginHistory.content(v.hash).toString('base64')]] : [])))
		let r = await pluginSyncClient.request({ type: 'plugin-sync', op: 'apply', file, versions, contents, ...(expected.client ? { target: expected.client } : {}), ...(expected.server ? { expect: expected.server } : {}) })
		if (r.stale) return pluginSyncClient.stale(file, 'server')
	}
	await pluginSyncClient.compare()
}

// Keep separate: this client's plugins/.syncignore gains `file`; no
// plugin file changes.
async function ignore(file: string): Promise<void> {
	if (!pluginSyncWire.isName(file)) throw new Error(`plugin sync: not a plugin filename: ${file}`)
	let path = join(pluginSync.dir(), '.syncignore')
	let text = existsSync(path) ? readFileSync(path, 'utf8') : ''
	if (!pluginSyncWire.ignoreList(text).includes(file)) {
		let tmp = `${path}.tmp.${process.pid}`
		writeFileSync(tmp, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${file}\n`)
		renameSync(tmp, path)
	}
	await pluginSyncClient.compare()
}

export const pluginSyncClient = {
	state: createState(),
	debounceMs: 300,
	send: (c: object): void => connection.send(c),
	// Called whenever state changes (b81 repaints its review).
	onChange: (): void => {},
	start,
	link,
	event,
	request,
	schedule,
	compare,
	run,
	relation,
	find,
	diff,
	stale,
	apply,
	ignore,
}
