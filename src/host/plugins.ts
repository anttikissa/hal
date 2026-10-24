// Plugins (task an, 90v): every plugins/*.ts in the home hooks
// functions on module objects, or sets their plain values (task d41). A
// file exports `default (plugin) => { ...; return cleanup }` and maybe
// `expires` (a UTC ISO time). The body registers hooks, which take
// effect at once, and returns its cleanup. Hooks are owned by their
// file: replacing, deleting or expiring it removes exactly its hooks,
// then runs its cleanup; an emptied chain puts the original back. A failed
// plugin stays on disk, inactive until edited or restarted.
// Every version seen is recorded by plugin-history.ts (task gev).

import { createHash } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, realpathSync, watch, type FSWatcher } from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import { paths } from './paths.ts'
import { pluginHistory } from './plugin-history.ts'

type Fn = (...args: any[]) => any
type Keys<T> = { [K in keyof T]-?: T[K] extends Fn ? K : never }[keyof T] & string
type F<T, K extends keyof T> = Extract<T[K], Fn>

// The registration function's argument. Types keep around's return
// type the target's: a sync target needs a sync replacement.
// After changing rendering state, call render.request(reason) from
// src/client/render.ts. Hooks apply during setup and are restored before
// the returned cleanup runs, so a redraw in either sees the right state.
// Example: themes/hal.ts.
export type Plugin = {
	before<T extends object, K extends Keys<T>>(obj: T, key: K, fn: (...args: Parameters<F<T, K>>) => void): void
	after<T extends object, K extends Keys<T>>(
		obj: T,
		key: K,
		fn: (result: ReturnType<F<T, K>>, args: Parameters<F<T, K>>) => void,
	): void
	around<T extends object, K extends Keys<T>>(
		obj: T,
		key: K,
		fn: NoInfer<(next: F<T, K>, ...args: Parameters<F<T, K>>) => ReturnType<F<T, K>>>,
	): void
	set<T extends object, K extends Exclude<keyof T & string, Keys<T>>>(obj: T, key: K, value: NoInfer<T[K]>): void
	// Switches this file off until it changes (task hvk): the body stops
	// here and what it registered so far goes.
	disable(): never
}

// What disable() throws; load() catches it.
const DISABLED = Symbol('plugin disabled')

type Kind = 'before' | 'after' | 'around' | 'set'
type Hook = { file: string; seq: number; kind: Kind; obj: any; key: string; fn: Fn; value?: unknown; target: string }
// What one call runs, replaced whole on every change, so a call already
// underway finishes with the chain it started with.
type Run = { befores: Fn[]; arounds: Fn[]; afters: Fn[] }
// A value patch (set) holds the value it applied instead of a wrapper.
type Patch = { original: any; wrapper: Fn; hooks: Hook[]; run: Run; value?: true; applied?: unknown }
// open: the registration body is running, so hooks may register.
export type Loaded = {
	path: string
	hash: string
	expires?: string
	portable?: true
	expired?: true
	disabled?: true
	error?: string
	hooks: Hook[]
	cleanup?: () => unknown
	open?: true
	timer?: Timer
}

type Directory = { watcher?: FSWatcher; ready: Promise<void> }

const srcDir = join(import.meta.dir, '..')

function dir(): string {
	return join(paths.home(), 'plugins')
}

function personalDir(): string {
	return join(paths.userHome(), '.agents/plugins/hal')
}

function imports(): void {
	if (plugins.state.imports) return
	Bun.plugin({
		name: 'hal-plugin-imports',
		setup(build) {
			build.onResolve({ filter: /^hal\// }, ({ path }) => ({ path: resolve(srcDir, path.slice(4)) }))
		},
	})
	plugins.state.imports = true
}

// Where failures go; on the host, main.ts sends them on (task njq).
// `path`: the plugin file a failure disabled.
function report(text: string, _path?: string): void {
	process.stderr.write(`${text}\n`)
}

// Hears a plugin file loaded, reloaded, removed, expired or disabled; on the host,
// main.ts sends it on (task b66).
function changed(_path: string, _what: 'loaded' | 'reloaded' | 'removed' | 'expired' | 'disabled'): void {}

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
	if (out && typeof out.then === 'function')
		out.then(undefined, (e: any) => plugins.report(`plugin ${what} failed: ${e?.stack ?? e}`))
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
			let call = (i: number, a: unknown[]): unknown =>
				i < arounds.length ? arounds[i]!((...x: unknown[]) => call(i + 1, x), ...a) : original.apply(this, a)
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
	let compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
	let order = (a: Hook, b: Hook) =>
		compare(basename(a.file), basename(b.file)) || compare(a.file, b.file) || a.seq - b.seq
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
	if (!entry.open)
		throw new Error(
			`${entry.path}: ${target} registered after the registration function returned; register in its body`,
		)
	let hook: Hook = { ...h, file: entry.path, seq: entry.hooks.length, target }
	entry.hooks.push(hook)
	let patch = plugins.patchOf(h.obj, h.key)
	patch.hooks.push(hook)
	plugins.settle(h.obj, h.key, patch)
}

function hook(entry: Loaded, kind: Kind, obj: any, key: string, fn: Fn): void {
	if (!obj || typeof obj[key] !== 'function')
		throw new Error(`${entry.path}: ${kind} target ${obj ? targetName(obj, key) : key} is not a function`)
	plugins.register(entry, { kind, obj, key, fn })
}

function override(entry: Loaded, obj: any, key: string, value: unknown): void {
	if (!obj || !(key in obj) || typeof obj[key] === 'function')
		throw new Error(`${entry.path}: set target ${obj ? targetName(obj, key) : key} is not a plain value; use around`)
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
		disable() {
			throw DISABLED
		},
	}
	return plugin
}

// Removes `entry`'s hooks once its expiry passes. Timers cap at ~24
// days, so a later expiry re-arms.
function arm(entry: Loaded): void {
	let ms = Date.parse(entry.expires!) - Date.now()
	entry.timer = setTimeout(
		() => (Date.parse(entry.expires!) <= Date.now() ? plugins.expire(entry.path) : plugins.arm(entry)),
		Math.min(Math.max(ms, 0), 2 ** 31 - 1),
	)
	entry.timer.unref?.()
}

function expire(path: string): void {
	let entry = plugins.state.files.get(path)
	if (!entry) return
	plugins.state.latest.set(path, ++plugins.state.gen)
	plugins.deactivate(entry)
	entry.expired = true
	plugins.changed(path, 'expired')
}

function hashOf(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8)
}

// Failure is local runtime state, not a source edit to propagate through sync.
function broken(path: string, hash: string, e: any): void {
	let st = plugins.state
	let old = st.files.get(path)
	if (old) plugins.deactivate(old)
	let error = String(e?.stack ?? e)
	let text = `plugin ${path} failed; inactive until edited or restarted. The file was not changed.\n${error}`
	st.files.set(path, { ...old, path, hash, hooks: [], error: text })
	plugins.report(text, path)
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
	let hash: string
	try {
		hash = hashOf(path)
	} catch (e: any) {
		if (e.code === 'ENOENT') return plugins.remove(path)
		plugins.report(`plugin ${path}: ${e?.stack ?? e}`, path)
		return
	}
	let entry: Loaded = { path, hash, hooks: [] }
	let mod: any
	try {
		plugins.imports()
		// A query string makes Bun import (and run) the file afresh. The
		// real path: through a symlinked directory (/tmp on macOS) Bun
		// cannot find a file created after it first resolved there.
		mod = await import(`${realpathSync(path)}?v=${gen}`)
		if (mod.expires !== undefined) {
			if (typeof mod.expires !== 'string' || !mod.expires.endsWith('Z') || Number.isNaN(Date.parse(mod.expires)))
				throw new Error(`${path}: expires must be a UTC ISO time like '2026-09-29T16:00:00Z'`)
			entry.expires = mod.expires
		}
		if (mod.portable !== undefined && mod.portable !== true) throw new Error(`${path}: portable must be true or absent`)
		if (mod.portable) entry.portable = true
		if (typeof mod.default !== 'function') throw new Error(`${path}: export default (plugin) => { ... } is missing`)
	} catch (e) {
		if (current()) plugins.broken(path, hash, e)
		return
	}
	if (!current()) return
	let old = st.files.get(path)
	if (old) plugins.deactivate(old)
	st.files.set(path, entry)
	if (entry.expires && Date.parse(entry.expires) <= Date.now())
		return void ((entry.expired = true), plugins.changed(path, 'expired'))
	entry.open = true
	try {
		let out = mod.default(plugins.api(entry))
		if (out !== undefined && typeof out !== 'function') {
			if (typeof out?.then === 'function')
				out.then(undefined, (e: any) =>
					plugins.report(`plugin ${path}: its async registration failed: ${e?.stack ?? e}`),
				)
			throw new Error(
				`${path}: the registration function returned ${typeof out?.then === 'function' ? 'a Promise' : typeof out}; return a cleanup function or nothing, and start async work from the body`,
			)
		}
		entry.cleanup = out
	} catch (e) {
		if (e !== DISABLED) return plugins.broken(path, hash, e)
		delete entry.open
		plugins.deactivate(entry)
		entry.disabled = true
		return plugins.changed(path, 'disabled')
	} finally {
		delete entry.open
	}
	if (entry.expires) plugins.arm(entry)
	plugins.changed(path, old && !old.error && !old.disabled ? 'reloaded' : 'loaded')
}

function remove(path: string): void {
	let st = plugins.state
	st.latest.set(path, ++st.gen)
	let entry = st.files.get(path)
	st.files.delete(path)
	if (!entry) return
	plugins.deactivate(entry)
	plugins.changed(path, 'removed')
}

// Brings file `name` in dir `d` up to date: loads it if its content
// changed since last tried, removes it if gone.
async function sync(d: string, name: string): Promise<void> {
	if (!name.endsWith('.ts') || name.endsWith('.d.ts')) return
	let path = join(d, name)
	pluginHistory.seen(path)
	try {
		let entry = plugins.state.files.get(path)
		if (entry?.hash === hashOf(path) && plugins.state.latest.has(path)) return
		await plugins.load(path)
	} catch (e: any) {
		if (e.code === 'ENOENT') plugins.remove(path)
		else plugins.report(`plugin ${path}: ${e?.stack ?? e}`, path)
	}
}

function activateDirectory(d: string): Promise<void> {
	d = resolve(d)
	let directories = plugins.state.directories
	let existing = directories.get(d)
	if (existing) return existing.ready
	let entry: Directory = { ready: Promise.resolve() }
	directories.set(d, entry)
	let current = () => directories.get(d) === entry
	entry.ready = Promise.resolve().then(async () => {
		if (!current()) return
		try {
			entry.watcher = watch(d, { persistent: false }, (_event, name) => {
				if (current() && name) void plugins.sync(d, name)
			})
			for (let name of readdirSync(d).sort()) {
				if (!current()) return
				await plugins.sync(d, name)
			}
		} catch (e) {
			if (current()) plugins.deactivateDirectory(d)
			throw e
		}
	})
	return entry.ready
}

function deactivateDirectory(d: string): void {
	d = resolve(d)
	let entry = plugins.state.directories.get(d)
	plugins.state.directories.delete(d)
	entry?.watcher?.close()
	let st = plugins.state
	for (let path of new Set([...st.files.keys(), ...st.latest.keys()])) {
		if (dirname(path) !== d) continue
		plugins.remove(path)
		st.latest.delete(path)
	}
}

// Both personal sources share this home's ledger; project sources stay outside it.
async function init(d?: string, personal?: string): Promise<void> {
	if (d === undefined) {
		d = plugins.dir()
		personal ??= plugins.personalDir()
	}
	d = resolve(d)
	if (personal) personal = resolve(personal)
	if (pluginHistory.state.dir) {
		await Promise.all([...plugins.state.directories.values()].map((entry) => entry.ready))
		return
	}
	mkdirSync(d, { recursive: true })
	if (personal) mkdirSync(personal, { recursive: true })
	plugins.state.personalDirectories = new Set([d, ...(personal ? [personal] : [])].map((dir) => realpathSync(dir)))
	pluginHistory.init(d, personal)
	await Promise.all([
		plugins.activateDirectory(d),
		...(personal && personal !== d ? [plugins.activateDirectory(personal)] : []),
	])
	if (plugins.state.directories.has(d)) plugins.state.started = true
}

// Takes `entry`'s hooks out, or puts them back, without its cleanup.
function mute(entry: Loaded, out: boolean): void {
	for (let h of entry.hooks) {
		let patch = plugins.patchOf(h.obj, h.key)
		patch.hooks = out ? patch.hooks.filter((x) => x !== h) : [...patch.hooks, h]
		plugins.settle(h.obj, h.key, patch)
	}
}

// Runs file `path` (none: nothing) in place of loaded plugin `hide`
// until unpreview(): a theme shown while a question's cursor is on it.
// Never listed, saved or reported as loaded. `hide` comes back unless
// it was reloaded meanwhile.
async function preview(hide: string, path?: string): Promise<void> {
	let st = plugins.state
	let gen = ++st.previewGen
	let mod: any
	plugins.imports()
	try {
		if (path) mod = await import(realpathSync(path))
	} catch (e: any) {
		return plugins.report(`preview ${path}: ${e?.stack ?? e}`)
	}
	if (gen !== st.previewGen) return
	plugins.unpreview(false)
	let hidden = st.files.get(hide)
	if (hidden) plugins.mute(hidden, true)
	let entry: Loaded = { path: path ?? hide, hash: '', hooks: [], open: true }
	st.preview = { entry, hidden }
	try {
		let out = mod?.default(plugins.api(entry))
		if (typeof out === 'function') entry.cleanup = out
	} catch (e: any) {
		plugins.report(`preview ${path}: ${e?.stack ?? e}`)
	} finally {
		delete entry.open
	}
}

function unpreview(last = true): void {
	let st = plugins.state
	if (last) st.previewGen++
	let p = st.preview
	if (!p) return
	st.preview = undefined
	plugins.deactivate(p.entry)
	if (p.hidden && st.files.get(p.hidden.path) === p.hidden) plugins.mute(p.hidden, false)
}

// Stops watching and removes every plugin's hooks.
function close(): void {
	plugins.state.started = false
	for (let d of plugins.state.directories.keys()) plugins.deactivateDirectory(d)
	plugins.state.personalDirectories.clear()
	pluginHistory.close()
	for (let path of plugins.state.files.keys()) plugins.remove(path)
	plugins.state.files.clear()
	plugins.state.latest.clear()
}

// One line per file for /plugins.
function describe(): string {
	let files = [...plugins.state.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
	if (!files.length) return `no plugins in ${plugins.dir()}`
	return files
		.map((f) => {
			let parts = [pluginHistory.fileName(f.path) ?? paths.display(f.path), f.hash]
			if (f.portable) parts.push('portable')
			if (f.disabled) parts.push('disabled')
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
		imports: false,
		directories: new Map<string, Directory>(),
		personalDirectories: new Set<string>(),
		started: false,
		preview: undefined as { entry: Loaded; hidden?: Loaded } | undefined,
		previewGen: 0,
	},
	dir,
	personalDir,
	imports,
	report,
	changed,
	patchOf,
	settle,
	deactivate,
	register,
	api,
	arm,
	expire,
	broken,
	hashOf,
	load,
	remove,
	sync,
	init,
	activateDirectory,
	deactivateDirectory,
	close,
	describe,
	mute,
	preview,
	unpreview,
}
