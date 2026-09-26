// Live files: a plain object backed by a small .ason file. This is the one
// way to keep small ASON state on disk; don't hand-roll reading and writing.
//
//   let data = liveFiles.liveFile(path, { enabled: true }, { mode: 0o600 })
//   data.enabled = false   // written atomically on the next microtask
//   liveFiles.save(data)   // write now; throws on failure
//   liveFiles.close(data)  // write pending changes, stop watching
//
// Changes are coalesced and written via temp file + rename. With watch
// (the default) external atomic replacements are loaded into the same
// object. A malformed file is an error, never reset to defaults, and is
// not overwritten until it is fixed. Merely reading never writes.
//
// Options for user-edited files (config.ason): keepBroken starts a
// malformed file from the defaults (reported, still never overwritten)
// instead of throwing; onChange hears every external edit, with the
// error if it left the file malformed.

import { chmodSync, renameSync, unlinkSync, watch, writeFileSync, readFileSync, type FSWatcher } from 'fs'
import { basename, dirname } from 'path'
import { ason } from '../common/ason.ts'
import { diag } from './diag.ts'

type Options = { watch?: boolean; mode?: number; keepBroken?: boolean; onChange?: (error: Error | null) => void }
type Data = Record<string, any>

interface LiveState {
	path: string
	mode: number | undefined
	onChange: ((error: Error | null) => void) | undefined
	data: Data
	// ason.stringify of what is on disk, or null if there is no file yet.
	synced: string | null
	dirty: boolean
	scheduled: boolean
	closed: boolean
	// Set while the file on disk is malformed; blocks writes over it.
	broken: Error | null
	watcher: FSWatcher | null
	debounce: ReturnType<typeof setTimeout> | null
	proxies: WeakMap<object, object>
	targets: WeakMap<object, object>
}

const registry = new WeakMap<object, LiveState>()

function fail(path: string, message: string): Error {
	return new Error(`${path}: ${message}`)
}

// Deep copy as plain data. Defaults may themselves be live proxies.
function copy(value: Data): Data {
	return ason.parse(ason.stringify(value)) as Data
}

// Parsed file content, or null if the file does not exist.
function read(path: string): Data | null {
	let text: string
	try {
		text = readFileSync(path, 'utf8')
	} catch (e: any) {
		if (e?.code === 'ENOENT') return null
		throw fail(path, e?.code ?? String(e))
	}
	let value: unknown
	try {
		value = ason.parse(text)
	} catch (e: any) {
		// First line only: the rest quotes file content, which may be secret.
		throw fail(path, `malformed ASON: ${String(e?.message).split('\n')[0]}`)
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(path, 'malformed ASON: not an object')
	return value as Data
}

function flush(state: LiveState): void {
	if (!state.dirty) return
	if (state.broken) throw fail(state.path, `not saving over malformed file (${state.broken.message})`)
	let text = ason.stringify(state.data)
	if (text === state.synced) {
		state.dirty = false
		return
	}
	let tmp = `${state.path}.tmp.${process.pid}`
	try {
		// Mode goes on the temp file so a secret is never briefly readable;
		// chmod too, since writeFileSync ignores mode for an existing file.
		writeFileSync(tmp, text + '\n', state.mode === undefined ? undefined : { mode: state.mode })
		if (state.mode !== undefined) chmodSync(tmp, state.mode)
		renameSync(tmp, state.path)
	} catch (e: any) {
		try {
			unlinkSync(tmp)
		} catch {}
		throw fail(state.path, `write failed: ${e?.message ?? e}`)
	}
	state.synced = text
	state.dirty = false
}

function markDirty(state: LiveState): void {
	state.dirty = true
	if (state.scheduled) return
	state.scheduled = true
	queueMicrotask(() => {
		state.scheduled = false
		try {
			flush(state)
		} catch (e) {
			liveFiles.onError(e as Error)
		}
	})
}

function reloadExternal(state: LiveState): void {
	if (state.closed) return
	let next: Data | null
	try {
		next = read(state.path)
	} catch (e) {
		state.broken = e as Error
		liveFiles.onError(e as Error)
		state.onChange?.(e as Error)
		return
	}
	let wasBroken = state.broken !== null
	state.broken = null
	// Deleted: keep what we have in memory.
	if (!next) return
	let text = ason.stringify(next)
	// Our own write, or nothing changed.
	if (text === state.synced) {
		if (wasBroken) state.onChange?.(null)
		return
	}
	state.synced = text
	// In place, so existing references see the new data. External wins
	// over any change not yet written.
	for (let key of Object.keys(state.data)) if (!(key in next)) delete state.data[key]
	Object.assign(state.data, next)
	state.dirty = false
	state.onChange?.(null)
}

function startWatch(state: LiveState): void {
	let name = basename(state.path)
	try {
		// Watch the directory: atomic replacement swaps the file's inode.
		state.watcher = watch(dirname(state.path), { persistent: false }, (_event, file) => {
			if (file && !String(file).startsWith(name)) return
			if (state.debounce) clearTimeout(state.debounce)
			state.debounce = setTimeout(() => {
				state.debounce = null
				reloadExternal(state)
			}, 50)
			state.debounce.unref?.()
		})
	} catch (e: any) {
		liveFiles.onError(fail(state.path, `cannot watch: ${e?.message ?? e}`))
	}
}

function proxy(state: LiveState, target: object): any {
	let existing = state.proxies.get(target)
	if (existing) return existing
	let handler: ProxyHandler<any> = {
		get(t, prop) {
			let value = Reflect.get(t, prop)
			if (value && typeof value === 'object') return proxy(state, value)
			return value
		},
		set(t, prop, value) {
			if (state.closed) throw fail(state.path, 'live file is closed')
			value = (value && typeof value === 'object' && state.targets.get(value)) || value
			if (Object.is(t[prop], value) && prop in t) return true
			t[prop] = value
			markDirty(state)
			return true
		},
		deleteProperty(t, prop) {
			if (state.closed) throw fail(state.path, 'live file is closed')
			if (!(prop in t)) return true
			delete t[prop]
			markDirty(state)
			return true
		},
	}
	let p = new Proxy(target, handler)
	state.proxies.set(target, p)
	state.targets.set(p, target)
	return p
}

function liveFile<T extends Data>(path: string, defaults: T, options: Options = {}): T {
	let disk: Data | null = null
	let broken: Error | null = null
	try {
		disk = read(path)
	} catch (e) {
		if (!options.keepBroken) throw e
		broken = e as Error
	}
	let data = copy(defaults)
	if (disk) Object.assign(data, disk)
	let state: LiveState = {
		path,
		mode: options.mode,
		onChange: options.onChange,
		data,
		synced: disk ? ason.stringify(disk) : null,
		dirty: false,
		scheduled: false,
		closed: false,
		broken,
		watcher: null,
		debounce: null,
		proxies: new WeakMap(),
		targets: new WeakMap(),
	}
	if (broken) liveFiles.onError(broken)
	if (options.watch !== false) startWatch(state)
	let root = proxy(state, data)
	registry.set(root, state)
	return root
}

function stateOf(data: object): LiveState {
	let state = registry.get(data)
	if (!state) throw new Error('not a live file')
	return state
}

// Write pending changes now. Throws if the write fails.
function save(data: object): void {
	flush(stateOf(data))
}

// Why the file on disk is unusable (malformed), or null.
function brokenError(data: object): Error | null {
	return stateOf(data).broken
}

// Write pending changes and stop watching; later changes throw.
function close(data: object): void {
	let state = stateOf(data)
	if (state.closed) return
	try {
		flush(state)
	} finally {
		state.closed = true
		state.watcher?.close()
		state.watcher = null
		if (state.debounce) clearTimeout(state.debounce)
		state.debounce = null
	}
}

// Errors nobody can catch: deferred writes and external edits.
function onError(error: Error): void {
	try {
		diag.log(error.message)
	} catch {}
}

export const liveFiles = { liveFile, save, close, brokenError, onError }
