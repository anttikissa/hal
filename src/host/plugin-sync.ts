// Plugin sync (task zh7), the part both homes run: this home's
// portable heads, its .syncignore, installing a version chosen on the
// other home, and the host's answers to a remote terminal's
// plugin-sync commands. The comparing side is plugin-sync-client.ts.
//
// Only plugins exporting portable = true take part (task gev). A home
// sends heads first; history and contents go only on request, and never
// for a name its plugins/.syncignore lists. Nothing is applied without a
// confirmed choice naming both expected heads: apply and fetch refuse
// (answer `stale`) when the head moved, and a repeat of an applied
// choice (a lost answer resent after reconnecting) finds the target
// already in place and does nothing. Versions arrive through
// pluginHistory.receive, so both versions stay in history, and the
// write goes through checkout's atomic write; the watcher then
// hot-reloads it, and pluginReports names the source in its notice.
// A review step (task b81) goes to plugin-sync-session.ts.
// Tasks: zh7, b81.

import { existsSync, readFileSync, realpathSync, unlinkSync } from 'fs'
import { hostname } from 'os'
import { basename, dirname, join } from 'path'
import type { Command, Event } from '../common/protocol.ts'
import { pluginSyncWire, type PluginSyncCommand, type PluginSyncEvent, type SyncHead, type SyncVersion } from '../common/plugin-sync.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { pluginHistory } from './plugin-history.ts'
import { pluginReports } from './plugin-reports.ts'
import { pluginSyncSession } from './plugin-sync-session.ts'
import { plugins } from './plugins.ts'

type Client = { deliver(event: Event): void }

const sha = (bytes: Uint8Array | string): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

// This home's identity: the same home reached twice (./run -r to
// one's own host) compares nothing.
function home(): string {
	let at = paths.home()
	try { at = realpathSync(at) } catch {}
	return sha(`${hostname()}\n${at}`).slice(0, 16)
}

// The plugins directory history follows; throws while history is off.
function dir(): string {
	let st = pluginHistory.state
	if (!st.dir || st.error) throw new Error(`plugin sync needs plugin history, which is unavailable: ${st.error ?? 'not started'}`)
	return st.dir
}

// Names in plugins/.syncignore; none if it is absent.
function ignored(): string[] {
	let path = join(pluginSync.dir(), '.syncignore')
	return existsSync(path) ? pluginSyncWire.ignoreList(readFileSync(path, 'utf8')) : []
}

// Loaded top-level plugins marked portable, expired ones included.
function portable(): string[] {
	let d = pluginSync.dir()
	return [...plugins.state.files.values()].filter((f) => f.portable && dirname(f.path) === d).map((f) => basename(f.path)).sort()
}

function headOf(file: string): SyncHead {
	let v = pluginHistory.head(file)
	if (!v) return { file }
	return { file, id: v.id, ts: v.ts, ...(v.hash ? { hash: v.hash } : {}), ...(v.deleted ? { deleted: true as const } : {}), ...(v.offline ? { offline: true as const } : {}) }
}

// Every recorded version of `file`, as the wire carries it.
function versionsOf(file: string): SyncVersion[] {
	let out: SyncVersion[] = []
	for (let v of pluginHistory.state.versions.values()) {
		if (v.file !== file) continue
		let { received: _, ...rest } = v
		out.push(rest)
	}
	return out
}

const encode = (hashes: Iterable<string>): Record<string, string> => Object.fromEntries([...new Set(hashes)].map((h) => [h, pluginHistory.content(h).toString('base64')]))

// Makes version `target` (undefined: no file) this home's `file`,
// after receiving `versions` (with `contents`, base64 by hash) into
// history. `source` and `side` name the change in its notice.
function install(file: string, versions: SyncVersion[], contents: Record<string, string>, target: string | undefined, source: string, side: 'client' | 'server'): void {
	let path = join(pluginSync.dir(), file)
	let bytes = new Map(Object.entries(contents).map(([h, b]) => [h, Buffer.from(b, 'base64') as Uint8Array]))
	pluginHistory.receive(versions, bytes)
	pluginHistory.seen(path)
	let cur = pluginHistory.head(file)
	if (target !== undefined) {
		let v = pluginHistory.state.versions.get(target)
		if (!v) throw new Error(`plugin sync: version ${target} of ${file} was not received`)
		if (cur?.id === target) return
		if (v.hash !== cur?.hash || !!v.deleted !== !!cur?.deleted) pluginReports.via(path, source, side)
		return pluginHistory.checkout(target)
	}
	if (!existsSync(path)) return
	pluginReports.via(path, source, side)
	unlinkSync(path)
	pluginHistory.seen(path)
}

// Whether `file`'s head already is `target` (undefined: no file).
function holds(file: string, target: string | undefined): boolean {
	let h = pluginSync.headOf(file)
	return target === undefined ? !h.id || !!h.deleted : h.id === target
}

// A host's answer to a plugin-sync command; throws to refuse it.
function command(client: Client, c: Extract<Command, { type: 'plugin-sync' }>): { reply: Event } {
	let reply = (fields: Omit<PluginSyncEvent, 'type'>): { reply: Event } => ({ reply: { type: 'plugin-sync', ...(c.id !== undefined ? { request: c.id } : {}), ...fields } })
	let ignore = new Set(pluginSync.ignored())
	let open = (file: string) => {
		if (ignore.has(file)) throw new Error(`plugin sync: ${file} is excluded by the server's plugins/.syncignore`)
	}
	let cmd = c as PluginSyncCommand
	if (cmd.op === 'inventory') {
		pluginSync.state.followers.set(client, cmd.home)
		let names = [...new Set([...pluginSync.portable(), ...cmd.names])].filter((n) => !ignore.has(n)).sort()
		return reply({ home: pluginSync.home(), heads: names.map(pluginSync.headOf), ignored: [...ignore] })
	}
	if (cmd.op === 'step') return pluginSyncSession.step(cmd), reply({})
	if (cmd.op === 'history') return reply({ versions: cmd.files.filter((f) => !ignore.has(f)).flatMap(pluginSync.versionsOf) })
	if (cmd.op === 'content') {
		let allowed = new Set([...pluginHistory.state.versions.values()].filter((v) => v.hash && !ignore.has(v.file)).map((v) => v.hash!))
		return reply({ contents: encode(cmd.hashes.filter((h) => allowed.has(h))) })
	}
	open(cmd.file)
	if (cmd.op === 'fetch') {
		let head = pluginSync.headOf(cmd.file)
		if (head.id !== cmd.expect) return reply({ stale: true, head })
		let known = new Set(cmd.known)
		let versions = pluginSync.versionsOf(cmd.file).filter((v) => !known.has(v.id))
		return reply({ versions, contents: encode(versions.flatMap((v) => (v.hash ? [v.hash] : []))) })
	}
	if (!pluginSync.holds(cmd.file, cmd.target)) {
		let head = pluginSync.headOf(cmd.file)
		if (head.id !== cmd.expect) return reply({ stale: true, head })
		pluginSync.install(cmd.file, cmd.versions, cmd.contents, cmd.target, 'a remote client', 'server')
	}
	return reply({ applied: true, head: pluginSync.headOf(cmd.file) })
}

// A plugin file changed here: tell following remote terminals, and
// let this home's own comparison (if it is one) run again.
function changed(path: string): void {
	let followers = pluginSync.state.followers
	for (let client of followers.keys()) {
		if (!host.state.clients.has(client as any)) followers.delete(client)
		else client.deliver({ type: 'plugin-sync', changed: true })
	}
	pluginSync.onLocal(path)
}

export const pluginSync = {
	// `followers`: clients that asked for an inventory on this host, with
	// the home they said they are.
	state: { followers: new Map<Client, string>() },
	sha,
	home,
	dir,
	ignored,
	portable,
	headOf,
	versionsOf,
	install,
	holds,
	command,
	changed,
	// Set by plugin-sync-client.ts on a remote terminal.
	onLocal: (_path: string): void => {},
}
