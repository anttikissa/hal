// Plugins (task an): every plugins/*.ts in the home hooks functions on
// module objects. A file exports `default (plugin) => {...}` and maybe
// `expires` (a UTC ISO time). Hooks are owned by their file: reloading,
// deleting or expiring it removes exactly its hooks, and an emptied
// chain puts the original function back. A reload is staged: the old
// hooks stay until the new file imported and registered cleanly. Once
// a swap is complete, the files' onChange callbacks reconcile whatever
// depends on the hooks (a theme repaints).

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, watch, type FSWatcher } from 'fs'
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
	unload(fn: () => void): void
	onChange(fn: (change: Change) => unknown): void
}

// 'load' is a file's first load; phase says whether this callback's
// version is coming in ('activate') or going out ('deactivate').
export type Change = { reason: 'load' | 'reload' | 'delete' | 'expire'; phase: 'activate' | 'deactivate' }

type Kind = 'before' | 'after' | 'around'
type Hook = { file: string; seq: number; kind: Kind; obj: any; key: string; fn: Fn; target: string }
// What one call runs, replaced whole on every change, so a call already
// underway finishes with the chain it started with.
type Run = { befores: Fn[]; arounds: Fn[]; afters: Fn[] }
type Patch = { original: Fn; wrapper: Fn; hooks: Hook[]; run: Run }
export type Loaded = { path: string; hash: string; expires?: string; expired?: true; error?: string; hooks: Hook[]; unloads: (() => void)[]; changes: Fn[]; active?: true; closed?: true; timer?: Timer }

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
	// Someone replaced the wrapper (eval, local.ts): theirs is the base now.
	if (patch && obj[key] === patch.wrapper) return patch
	let run: Run = { befores: [], arounds: [], afters: [] }
	let original: Fn = obj[key]
	let p: Patch = {
		original,
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
// registration order; an empty chain restores the original exactly.
function settle(obj: any, key: string, patch: Patch): void {
	let order = (a: Hook, b: Hook) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.seq - b.seq)
	let hooks = patch.hooks.sort(order)
	let of = (kind: Kind) => hooks.filter((h) => h.kind === kind).map((h) => h.fn)
	patch.run = { befores: of('before'), arounds: of('around'), afters: of('after') }
	if (hooks.length) obj[key] = patch.wrapper
	else {
		if (obj[key] === patch.wrapper) obj[key] = patch.original
		plugins.state.patches.get(obj)?.delete(key)
	}
}

// Runs every callback in `fns`; one that throws or rejects is
// reported and the rest still run. Results are not awaited.
function runAll(path: string, what: string, fns: Fn[], ...args: unknown[]): void {
	let fail = (e: any) => plugins.report(`plugin ${path}: ${what} failed: ${e?.stack ?? e}`)
	for (let fn of fns) {
		try {
			let out = fn(...args)
			if (out && typeof out.then === 'function') out.then(undefined, fail)
		} catch (e) {
			fail(e)
		}
	}
}

// Takes `entry`'s hooks out and runs its unload callbacks. Returns its
// onChange callbacks, for the caller to run once its swap is complete.
function deactivate(entry: Loaded): Fn[] {
	clearTimeout(entry.timer)
	for (let h of entry.hooks) {
		let patch = plugins.state.patches.get(h.obj)?.get(h.key)
		if (!patch) continue
		patch.hooks = patch.hooks.filter((x) => x !== h)
		plugins.settle(h.obj, h.key, patch)
	}
	let { unloads, changes } = entry
	entry.closed = true
	entry.hooks = []
	entry.unloads = []
	entry.changes = []
	runAll(entry.path, 'unload', unloads)
	return changes
}

// A load that never activates: its staged cleanups run at once, so a
// timer or connection it started does not leak.
function discard(staged: Loaded): void {
	let unloads = staged.unloads
	staged.closed = true
	staged.unloads = []
	runAll(staged.path, 'unload', unloads)
}

function activate(entry: Loaded): void {
	entry.active = true
	for (let h of entry.hooks) {
		let patch = plugins.patchOf(h.obj, h.key)
		patch.hooks.push(h)
		plugins.settle(h.obj, h.key, patch)
	}
	if (entry.expires) plugins.arm(entry)
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
	let changes = plugins.deactivate(entry)
	entry.expired = true
	runAll(path, 'onChange', changes, { reason: 'expire', phase: 'deactivate' })
}

// A registration recorder: hooks and unloads are only collected here,
// checked, and activated by load() once registration succeeded. An
// unload registered late (from a timer) after its version was removed
// or dropped runs at once, so its resource does not leak.
function recorder(path: string, entry: Loaded): Plugin {
	let add = (kind: Kind) => (obj: any, key: string, fn: Fn) => {
		if (!obj || typeof obj[key] !== 'function') throw new Error(`${path}: ${kind} target ${obj ? targetName(obj, key) : key} is not a function`)
		entry.hooks.push({ file: basename(path), seq: entry.hooks.length, kind, obj, key, fn, target: `${targetName(obj, key)} ${kind}` })
	}
	return { before: add('before'), after: add('after'), around: add('around'), unload: (fn) => void (entry.closed ? runAll(path, 'unload', [fn]) : entry.unloads.push(fn)), onChange: (fn) => void entry.changes.push(fn) } as Plugin
}

// (Re)loads plugin file `path`. The file's old hooks stay unless the new
// version imported and registered cleanly and nothing newer (an edit,
// deletion or expiry) came meanwhile.
async function load(path: string): Promise<void> {
	let st = plugins.state
	let gen = ++st.gen
	st.latest.set(path, gen)
	let current = () => st.latest.get(path) === gen
	let text = readFileSync(path)
	let staged: Loaded = { path, hash: createHash('sha256').update(text).digest('hex').slice(0, 8), hooks: [], unloads: [], changes: [] }
	let old = st.files.get(path)
	try {
		// A query string makes Bun import (and run) the file afresh. The
		// real path: through a symlinked directory (/tmp on macOS) Bun
		// cannot find a file created after it first resolved there.
		let mod = await import(`${realpathSync(path)}?v=${gen}`)
		if (mod.expires !== undefined) {
			if (typeof mod.expires !== 'string' || !mod.expires.endsWith('Z') || Number.isNaN(Date.parse(mod.expires))) throw new Error(`${path}: expires must be a UTC ISO time like '2026-09-29T16:00:00Z'`)
			staged.expires = mod.expires
		}
		if (!current()) return
		let expired = () => staged.expires !== undefined && Date.parse(staged.expires) <= Date.now()
		if (!expired()) {
			if (typeof mod.default !== 'function') throw new Error(`${path}: export default (plugin) => { ... } is missing`)
			await mod.default(plugins.recorder(path, staged))
		}
		if (!current()) return plugins.discard(staged)
		let reload = !!old?.active
		let outgoing = old ? plugins.deactivate(old) : []
		st.files.set(path, staged)
		if (expired()) staged.expired = true
		else plugins.activate(staged)
		// Both versions' callbacks see the new hooks already active.
		let reason = reload ? 'reload' : 'load'
		runAll(path, 'onChange', outgoing, { reason, phase: 'deactivate' })
		runAll(path, 'onChange', staged.changes, { reason, phase: 'activate' })
	} catch (e: any) {
		plugins.discard(staged)
		if (!current()) return
		let error = String(e?.message ?? e)
		if (!error.includes(path)) error = `${path}: ${error}`
		if (old) Object.assign(old, { error, hash: staged.hash })
		else st.files.set(path, { ...staged, hooks: [], unloads: [], changes: [], error })
		plugins.report(`plugin failed to load, keeping its last working hooks: ${error}`)
	}
}

function remove(path: string): void {
	let st = plugins.state
	st.latest.set(path, ++st.gen)
	let entry = st.files.get(path)
	st.files.delete(path)
	if (entry) runAll(path, 'onChange', plugins.deactivate(entry), { reason: 'delete', phase: 'deactivate' })
}

// Brings file `name` in dir `d` up to date: loads it if its content
// changed since last tried, removes it if gone.
async function sync(d: string, name: string): Promise<void> {
	if (!name.endsWith('.ts') || name.endsWith('.d.ts')) return
	let path = join(d, name)
	if (!existsSync(path)) return plugins.remove(path)
	let hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8)
	let entry = plugins.state.files.get(path)
	if (entry?.hash === hash && plugins.state.latest.has(path)) return
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
	discard,
	activate,
	arm,
	expire,
	recorder,
	load,
	remove,
	sync,
	init,
	close,
	describe,
}
