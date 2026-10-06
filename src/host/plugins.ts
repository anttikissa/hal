// Plugins (task an, 90v): every plugins/*.ts in the home hooks
// functions on module objects, or sets their plain values (task d41). A
// file exports `default (plugin) => { ...; return cleanup }` and maybe
// `expires` (a UTC ISO time). The body registers hooks, which take
// effect at once, and returns its cleanup. Hooks are owned by their
// file: replacing, deleting or expiring it removes exactly its hooks,
// then runs its cleanup; an emptied chain puts the original back. A file
// that fails to import or throws in its body is renamed to .ts.broken.

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, watch, type FSWatcher } from 'fs'
import { basename, join, relative } from 'path'
import { paths } from './paths.ts'

type Fn = (...args: any[]) => any
type Keys<T> = { [K in keyof T]-?: T[K] extends Fn ? K : never }[keyof T] & string
type F<T, K extends keyof T> = Extract<T[K], Fn>

// The registration function's argument. Types keep around's return
// type the target's: a sync target needs a sync replacement.
export type Plugin = {
	before<T extends object, K extends Keys<T>>(obj: T, key: K, fn: (...args: Parameters<F<T, K>>) => void): void
	after<T extends object, K extends Keys<T>>(obj: T, key: K, fn: (result: ReturnType<F<T, K>>, args: Parameters<F<T, K>>) => void): void
	around<T extends object, K extends Keys<T>>(obj: T, key: K, fn: NoInfer<(next: F<T, K>, ...args: Parameters<F<T, K>>) => ReturnType<F<T, K>>>): void
	set<T extends object, K extends Exclude<keyof T & string, Keys<T>>>(obj: T, key: K, value: NoInfer<T[K]>): void
}

type Kind = 'before' | 'after' | 'around' | 'set'
type Hook = { file: string; seq: number; kind: Kind; obj: any; key: string; fn: Fn; value?: unknown; target: string }
// What one call runs, replaced whole on every change, so a call already
// underway finishes with the chain it started with.
type Run = { befores: Fn[]; arounds: Fn[]; afters: Fn[] }
// A value patch (set) holds the value it applied instead of a wrapper.
type Patch = { original: any; wrapper: Fn; hooks: Hook[]; run: Run; value?: true; applied?: unknown }
// open: the registration body is running, so hooks may register.
export type Loaded = { path: string; hash: string; expires?: string; expired?: true; error?: string; hooks: Hook[]; cleanup?: () => unknown; open?: true; timer?: Timer }

const srcDir = join(import.meta.dir, '..')

function dir(): string {
	return join(paths.home(), 'plugins')
}

// Where failures go; main.ts adds open sessions and clients on the host.
function report(text: string): void {
	process.stderr.write(`${text}\n`)
}

// "host/auth.pickAccount": the module exporting `obj`, then the key.
function targetName(obj: object, key: string): string {
	for (let [file, mod] of Object.entries(require.cache)) {
		try {
			if (!Object.values(mod?.exports ?? {}).includes(obj)) continue
			let rel = file.startsWith(srcDir) ? relative(srcDir, file) : basename(file)
			return `${rel.replace(/\.tsx?$/, '')}.${key}`
		} catch {}
	}
	return `?.${key}`
}

// A returned Promise is not awaited, but its rejection is reported.
function observe(fn: Fn, args: unknown[], what: string): void {
	let out = fn(...args)
	if (out && typeof out.then === 'function') out.then(undefined, (e: any) => plugins.report(`plugin ${what} failed: ${e?.stack ?? e}`))
}

function patchOf(obj: any, key: string): Patch {
	let map: Map<string, Patch> = (plugins.state.patches.get(obj) as any) ?? new Map()
	plugins.state.patches.set(obj, map)
	let patch = map.get(key)
	// Someone replaced the wrapper or value (eval, local.ts): theirs is
	// the base now.
	if (patch && obj[key] === (patch.value ? patch.applied : patch.wrapper)) return patch
	let run: Run = { befores: [], arounds: [], afters: [] }
	let original: Fn = obj[key]
	let p: Patch = {
		original,
		...(typeof original === 'function' ? {} : { value: true as const }),
		hooks: [],
		run,
		wrapper: function (this: unknown, ...args: unknown[]) {
			let { befores, arounds, afters } = p.run
			for (let fn of befores) observe(fn, args, `before ${key}`)
			let call = (i: number, a: unknown[]): unknown => (i < arounds.length ? arounds[i]!((...x: unknown[]) => call(i + 1, x), ...a) : original.apply(this, a))
			let result = call(0, args)
			for (let fn of afters) observe(fn, [result, args], `after ${key}`)
			return result
		},
	}
	map.set(key, p)
	return p
}

// Rebuilds `patch`'s run from its hooks, in file order then
// registration order; the last set wins. An empty chain restores the
// original exactly.
function settle(obj: any, key: string, patch: Patch): void {
	let order = (a: Hook, b: Hook) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.seq - b.seq)
	let hooks = patch.hooks.sort(order)
	let of = (kind: Kind) => hooks.filter((h) => h.kind === kind).map((h) => h.fn)
	patch.run = { befores: of('before'), arounds: of('around'), afters: of('after') }
	if (hooks.length) obj[key] = patch.value ? (patch.applied = hooks.at(-1)!.value) : patch.wrapper
	else {
		if (obj[key] === (patch.value ? patch.applied : patch.wrapper)) obj[key] = patch.original
		plugins.state.patches.get(obj)?.delete(key)
	}
}

// Runs `fn` (a cleanup); a throw or rejection is reported.
function run(path: string, what: string, fn: Fn | undefined): void {
	let fail = (e: any) => plugins.report(`plugin ${path}: ${what} failed: ${e?.stack ?? e}`)
	try {
		let out = fn?.()
		if (out && typeof out.then === 'function') out.then(undefined, fail)
	} catch (e) {
		fail(e)
	}
}

// Takes `entry`'s hooks out, then runs its cleanup.
function deactivate(entry: Loaded): void {
	clearTimeout(entry.timer)
	delete entry.open
	for (let h of entry.hooks) {
		let patch = plugins.state.patches.get(h.obj)?.get(h.key)
		if (!patch) continue
		patch.hooks = patch.hooks.filter((x) => x !== h)
		plugins.settle(h.obj, h.key, patch)
	}
	let cleanup = entry.cleanup
	entry.hooks = []
	entry.cleanup = undefined
	run(entry.path, 'cleanup', cleanup)
}

// Adds hook `h` to `entry` and puts it into effect at once.
// Registration is final once the body returns.
function register(entry: Loaded, h: Omit<Hook, 'file' | 'seq' | 'target'>): void {
	let target = `${targetName(h.obj, h.key)} ${h.kind}`
	if (!entry.open) throw new Error(`${entry.path}: ${target} registered after the registration function returned; register in its body`)
	let hook: Hook = { ...h, file: basename(entry.path), seq: entry.hooks.length, target }
	entry.hooks.push(hook)
	let patch = plugins.patchOf(h.obj, h.key)
	patch.hooks.push(hook)
	plugins.settle(h.obj, h.key, patch)
}

function hook(entry: Loaded, kind: Kind, obj: any, key: string, fn: Fn): void {
	if (!obj || typeof obj[key] !== 'function') throw new Error(`${entry.path}: ${kind} target ${obj ? targetName(obj, key) : key} is not a function`)
	plugins.register(entry, { kind, obj, key, fn })
}

function override(entry: Loaded, obj: any, key: string, value: unknown): void {
	if (!obj || !(key in obj) || typeof obj[key] === 'function') throw new Error(`${entry.path}: set target ${obj ? targetName(obj, key) : key} is not a plain value; use around`)
	plugins.register(entry, { kind: 'set', obj, key, fn: () => value, value })
}

// The API one file version registers through.
function api(entry: Loaded): Plugin {
	const plugin: Plugin = {
		before(obj, key, fn) {
			hook(entry, 'before', obj, key, fn)
		},
		after(obj, key, fn) {
			hook(entry, 'after', obj, key, fn)
		},
		around(obj, key, fn) {
			hook(entry, 'around', obj, key, fn)
		},
		set(obj, key, value) {
			override(entry, obj, key, value)
		},
	}
	return plugin
}

// Removes `entry`'s hooks once its expiry passes. Timers cap at ~24
// days, so a later expiry re-arms.
function arm(entry: Loaded): void {
	let ms = Date.parse(entry.expires!) - Date.now()
	entry.timer = setTimeout(() => (Date.parse(entry.expires!) <= Date.now() ? plugins.expire(entry.path) : plugins.arm(entry)), Math.min(Math.max(ms, 0), 2 ** 31 - 1))
	entry.timer.unref?.()
}

function expire(path: string): void {
	let entry = plugins.state.files.get(path)
	if (!entry) return
	plugins.state.latest.set(path, ++plugins.state.gen)
	plugins.deactivate(entry)
	entry.expired = true
}

function hashOf(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8)
}

// A file that failed to import or register, like a config file that
// does not parse: Hal runs without it and renames it to .ts.broken, so
// the next start skips it too. No rollback to an earlier version. A file
// that changed since it was read is still being written: a newer load
// follows, so it stays.
function broken(path: string, hash: string, e: any): void {
	let st = plugins.state
	let old = st.files.get(path)
	if (old) plugins.deactivate(old)
	let error = String(e?.stack ?? e)
	if (!error.includes(path)) error = `${path}: ${error}`
	let to = `${path}.broken`
	let text: string
	try {
		if (hashOf(path) !== hash) return
		renameSync(path, to)
		text = `plugin ${path} failed and was renamed to ${to}, so it does not load again; Hal runs without it. Fix it and rename it back to ${basename(path)} to enable it.\n${error}`
	} catch (r: any) {
		text = `plugin ${path} failed; Hal runs without it, but renaming it to ${to} failed too (${r?.message ?? r}).\n${error}`
	}
	st.files.set(path, { path, hash, hooks: [], error: text })
	plugins.report(text)
}

// (Re)loads plugin file `path`: the old version's hooks go and its
// cleanup runs, then the new body runs, its hooks active as it
// registers them. A load overtaken by a newer edit, deletion or expiry
// while importing is dropped.
async function load(path: string): Promise<void> {
	let st = plugins.state
	let gen = ++st.gen
	st.latest.set(path, gen)
	let current = () => st.latest.get(path) === gen
	let hash = hashOf(path)
	let entry: Loaded = { path, hash, hooks: [] }
	let mod: any
	try {
		// A query string makes Bun import (and run) the file afresh. The
		// real path: through a symlinked directory (/tmp on macOS) Bun
		// cannot find a file created after it first resolved there.
		mod = await import(`${realpathSync(path)}?v=${gen}`)
		if (mod.expires !== undefined) {
			if (typeof mod.expires !== 'string' || !mod.expires.endsWith('Z') || Number.isNaN(Date.parse(mod.expires))) throw new Error(`${path}: expires must be a UTC ISO time like '2026-09-29T16:00:00Z'`)
			entry.expires = mod.expires
		}
		if (typeof mod.default !== 'function') throw new Error(`${path}: export default (plugin) => { ... } is missing`)
	} catch (e) {
		if (current()) plugins.broken(path, hash, e)
		return
	}
	if (!current()) return
	let old = st.files.get(path)
	if (old) plugins.deactivate(old)
	st.files.set(path, entry)
	if (entry.expires && Date.parse(entry.expires) <= Date.now()) return void (entry.expired = true)
	entry.open = true
	try {
		let out = mod.default(plugins.api(entry))
		if (out !== undefined && typeof out !== 'function') {
			if (typeof out?.then === 'function') out.then(undefined, (e: any) => plugins.report(`plugin ${path}: its async registration failed: ${e?.stack ?? e}`))
			throw new Error(`${path}: the registration function returned ${typeof out?.then === 'function' ? 'a Promise' : typeof out}; return a cleanup function or nothing, and start async work from the body`)
		}
		entry.cleanup = out
	} catch (e) {
		return plugins.broken(path, hash, e)
	} finally {
		delete entry.open
	}
	if (entry.expires) plugins.arm(entry)
}

function remove(path: string): void {
	let st = plugins.state
	st.latest.set(path, ++st.gen)
	let entry = st.files.get(path)
	// A broken file's entry stays, so /plugins shows why it went.
	if (entry?.error) return
	st.files.delete(path)
	if (entry) plugins.deactivate(entry)
}

// Brings file `name` in dir `d` up to date: loads it if its content
// changed since last tried, removes it if gone.
async function sync(d: string, name: string): Promise<void> {
	if (!name.endsWith('.ts') || name.endsWith('.d.ts')) return
	let path = join(d, name)
	if (!existsSync(path)) return plugins.remove(path)
	let entry = plugins.state.files.get(path)
	if (entry?.hash === hashOf(path) && !entry.error && plugins.state.latest.has(path)) return
	await plugins.load(path)
}

// Loads every plugin in filename order, then follows the directory.
async function init(d = plugins.dir()): Promise<void> {
	if (plugins.state.watcher) return
	mkdirSync(d, { recursive: true })
	for (let name of readdirSync(d).sort()) await plugins.sync(d, name)
	plugins.state.watcher = watch(d, { persistent: false }, (_event, name) => {
		if (name) void plugins.sync(d, name)
	})
}

// Stops watching and removes every plugin's hooks.
function close(): void {
	plugins.state.watcher?.close()
	plugins.state.watcher = undefined
	for (let path of plugins.state.files.keys()) plugins.remove(path)
	plugins.state.files.clear()
}

// One line per file for /plugins.
function describe(): string {
	let files = [...plugins.state.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
	if (!files.length) return `no plugins in ${plugins.dir()}`
	return files
		.map((f) => {
			let parts = [basename(f.path), f.hash]
			if (f.expires) parts.push(`${f.expired ? 'expired' : 'expires'} ${f.expires}`)
			parts.push(f.hooks.length ? f.hooks.map((h) => h.target).join(', ') : 'no hooks')
			if (f.error) parts.push(`error: ${f.error}`)
			return parts.join('  ')
		})
		.join('\n')
}

export const plugins = {
	state: {
		files: new Map<string, Loaded>(),
		patches: new Map<object, Map<string, Patch>>(),
		// The newest load generation per file; an older one is discarded.
		latest: new Map<string, number>(),
		gen: 0,
		watcher: undefined as FSWatcher | undefined,
	},
	dir,
	report,
	patchOf,
	settle,
	deactivate,
	register,
	api,
	arm,
	expire,
	broken,
	load,
	remove,
	sync,
	init,
	close,
	describe,
}
