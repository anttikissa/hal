// Plugin version history (task gev): every version of a top-level
// plugins/*.ts this home observes, as one ASONL record per version in
// plugins/history.asonl, its bytes under plugins/history/<sha256>. Both
// are private and gitignored, and outside what the loader reads.
//
// A version is { id, file, hash, parent, ts }; a deletion has `deleted`
// and no hash, so an empty file (the empty hash) differs from absence.
// `ts` is when this home observed it; `offline` marks one found by the
// startup scan, made at some unknown time while Hal was stopped. The id
// hashes file, hash, parent and ts, so a revert to earlier bytes is a
// new version, not the old one. A received version keeps its id, ts and
// parent; { file, checkout: id, ts } makes a known version the file's
// head again (choosing an older one). `received` marks one taken from
// another home; it leaves the file and its head alone. Otherwise the
// newest record per file is its head: the next version's parent.
//
// Bytes are stored (temp + rename) before the record naming them is
// appended, and a checkout writes the file before its record, so no
// interruption loses a version. The ledger is read once at init and
// indexed; afterwards only actual file events touch it. A torn last line
// (crash mid-append) is cut; any other bad record stops the history with
// its path and error, and nothing more is written. No pruning, no merge.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, truncateSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import { history } from './history.ts'
import { plugins } from './plugins.ts'

export type Version = { id: string; file: string; hash?: string; parent?: string; ts: string; deleted?: true; offline?: true; received?: true }
type Checkout = { file: string; checkout: string; ts: string }

const sha = (bytes: Uint8Array | string): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const isPlugin = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.includes('/')

function idOf(v: Omit<Version, 'id'>): string {
	return sha(`${v.file}\n${v.hash ?? 'deleted'}\n${v.parent ?? ''}\n${v.ts}`).slice(0, 16)
}

function ledger(): string {
	return join(pluginHistory.state.dir!, 'history.asonl')
}

// The bytes of a version with content `hash`.
function content(hash: string): Buffer {
	return readFileSync(join(pluginHistory.state.dir!, 'history', hash))
}

function writeAtomic(path: string, bytes: Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true })
	let tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}`)
	writeFileSync(tmp, bytes)
	renameSync(tmp, path)
}

function store(hash: string, bytes: Uint8Array): void {
	let path = join(pluginHistory.state.dir!, 'history', hash)
	if (!existsSync(path)) writeAtomic(path, bytes)
}

function append(record: Version | Checkout): void {
	history.write(ledger(), lines.encode(record))
	pluginHistory.index(record)
}

function index(record: Version | Checkout): void {
	let st = pluginHistory.state
	if ('checkout' in record) return void st.heads.set(record.file, record.checkout)
	st.versions.set(record.id, record)
	if (!record.received) st.heads.set(record.file, record.id)
}

function head(file: string): Version | undefined {
	let id = pluginHistory.state.heads.get(file)
	return id === undefined ? undefined : pluginHistory.state.versions.get(id)
}

// Records `file`'s bytes (undefined: absent) if they differ from its head.
function observe(file: string, bytes: Uint8Array | undefined, offline?: boolean): Version | undefined {
	let st = pluginHistory.state
	if (!st.dir || st.error) return
	let prev = head(file)
	let hash = bytes && sha(bytes)
	if (hash ? prev?.hash === hash : !prev || prev.deleted) return
	if (bytes) pluginHistory.store(hash!, bytes)
	let base = { file, ...(hash ? { hash } : { deleted: true as const }), ...(prev ? { parent: prev.id } : {}), ts: new Date().toISOString() }
	let v: Version = { id: idOf(base), ...base, ...(offline ? { offline: true as const } : {}) }
	append(v)
	return v
}

// The loader saw `path` change (watcher or startup); a failure is reported.
function seen(path: string): void {
	let st = pluginHistory.state
	if (!st.dir || dirname(path) !== st.dir) return
	try {
		let bytes: Buffer | undefined
		try { bytes = readFileSync(path) } catch (e: any) { if (e?.code !== 'ENOENT') throw e }
		pluginHistory.observe(basename(path), bytes)
	} catch (e: any) {
		plugins.report(`plugin history ${ledger()}: recording ${path} failed: ${e?.stack ?? e}`)
	}
}

// Takes in versions from another home, keeping their id, ts and parent.
// `bytes`: their contents by hash. Checks every field before storing.
function receive(list: Version[], bytes: Map<string, Uint8Array>): void {
	if (!pluginHistory.state.dir || pluginHistory.state.error) throw new Error(`plugin history unavailable: ${pluginHistory.state.error ?? 'not started'}`)
	for (let v of list) {
		if (pluginHistory.state.versions.has(v.id)) continue
		let { id, file, hash, parent, ts, deleted } = v
		let clean: Version = { id, file, ...(hash ? { hash } : {}), ...(parent ? { parent } : {}), ts, ...(deleted ? { deleted } : {}), ...(v.offline ? { offline: true } : {}) }
		let data = hash ? bytes.get(hash) : undefined
		if (!isPlugin(file) || typeof ts !== 'string' || !hash === !deleted || id !== idOf(clean) || (hash && (!data || sha(data) !== hash)))
			throw new Error(`plugin history: received version is invalid or lacks its contents: ${ason.stringify(v, 'short')}`)
		if (hash) pluginHistory.store(hash, data!)
		append({ ...clean, received: true })
	}
}

// Makes known version `id` its file's content and head. Unrecorded
// local bytes are recorded first, so they stay recoverable.
function checkout(id: string): void {
	let st = pluginHistory.state
	let v = st.versions.get(id)
	if (!v || !st.dir || st.error) throw new Error(`plugin history: cannot check out ${id}: ${st.error ?? 'unknown version'}`)
	let path = join(st.dir, v.file)
	pluginHistory.seen(path)
	if (v.deleted) {
		if (existsSync(path)) unlinkSync(path)
	} else writeAtomic(path, pluginHistory.content(v.hash!))
	append({ file: v.file, checkout: id, ts: new Date().toISOString() })
}

// Reads and indexes the ledger, then records what changed while Hal
// was stopped. A corrupt ledger is reported and disables the history.
function init(dir: string): void {
	let st = pluginHistory.state
	st.dir = dir
	st.error = undefined
	st.versions.clear()
	st.heads.clear()
	let path = ledger()
	try {
		let text = existsSync(path) ? readFileSync(path, 'utf8') : ''
		let end = text.lastIndexOf('\n') + 1
		if (end < text.length) truncateSync(path, Buffer.byteLength(text.slice(0, end)))
		text.slice(0, end).split('\n').forEach((line, i) => {
			if (!line) return
			try {
				pluginHistory.index(ason.parse(line) as any)
			} catch (e: any) {
				throw new Error(`${path}:${i + 1}: ${e?.message ?? e}\n${line}`)
			}
		})
	} catch (e: any) {
		st.error = String(e?.message ?? e)
		return plugins.report(`plugin history ${path} is unreadable; plugin versions are not recorded until it is fixed.\n${st.error}`)
	}
	let names = new Set(readdirSync(dir).filter(isPlugin))
	for (let file of new Set([...names, ...st.heads.keys()])) {
		try {
			pluginHistory.observe(file, names.has(file) ? readFileSync(join(dir, file)) : undefined, true)
		} catch (e: any) {
			plugins.report(`plugin history ${path}: recording ${file} failed: ${e?.stack ?? e}`)
		}
	}
}

function close(): void {
	pluginHistory.state.dir = undefined
}

export const pluginHistory = {
	// `dir`: the plugins directory followed; `versions` by id; `heads`:
	// each file's current version id; `error`: why the ledger is unusable.
	state: { dir: undefined as string | undefined, error: undefined as string | undefined, versions: new Map<string, Version>(), heads: new Map<string, string>() },
	idOf, content, store, index, head, observe, seen, receive, checkout, init, close,
}
