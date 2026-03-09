// liveFile — proxy-backed auto-persist object.
// Deep property writes mark dirty → flush on next microtask.
// Atomic writes (tmp + rename). Optional fs.watch for external edits.
//
// ⚠ CAVEATS — read before using:
//
// Don't stash nested objects:
//   const f = liveFile('file.ason', { defaults: { foo: { bar: 1 } } })
//   const bad = f.foo       // proxy around current data.foo
//   // ...time passes, file reloads from disk (fs.watch / external edit)...
//   bad.bar = 2             // SILENTLY LOST — bad wraps the old object,
//                           // but data.foo is now a new object from disk.
//                           // dirty flag fires, but flush writes data (with new foo).
//
// Safe pattern: always access through the root proxy.
//   f.foo.bar = 2           // ✅ f.foo re-fetches data.foo each time

import { readFileSync, writeFileSync, renameSync, watch, existsSync } from 'fs'
import { stringify, parse } from './utils/ason.ts'
import { ensureDir } from './state.ts'
import { dirname, basename } from 'path'

interface LiveFileOptions<T> {
	defaults: T
	watch?: boolean
}

export function liveFile<T extends Record<string, any>>(path: string, opts: LiveFileOptions<T>): T {
	let data: T = { ...opts.defaults }
	let dirty = false
	let flushScheduled = false

	// Load from disk
	if (existsSync(path)) {
		try {
			const raw = readFileSync(path, 'utf-8')
			data = { ...opts.defaults, ...(parse(raw) as Record<string, unknown>) }
		} catch {}
	}

	function flush(): void {
		if (!dirty) return
		dirty = false
		ensureDir(dirname(path))
		const tmp = `${path}.tmp.${process.pid}`
		writeFileSync(tmp, stringify(data) + '\n')
		renameSync(tmp, path)
	}

	function scheduleFlush(): void {
		if (flushScheduled) return
		flushScheduled = true
		queueMicrotask(() => {
			flushScheduled = false
			flush()
		})
	}

	// Watch directory (not file) so atomic tmp+rename doesn't kill the watcher
	if (opts.watch !== false) {
		let debounce: ReturnType<typeof setTimeout> | null = null
		let ownWrite = false
		const origFlush = flush
		flush = function () {
			ownWrite = true
			origFlush()
			// Reset after microtask so the fs.watch callback can check
			queueMicrotask(() => { ownWrite = false })
		}
		const dir = dirname(path)
		const base = basename(path)
		try {
			watch(dir, { persistent: false }, (_, filename) => {
				if (filename && filename !== base) return
				if (ownWrite) return
				if (debounce) clearTimeout(debounce)
				debounce = setTimeout(() => {
					try {
						const raw = readFileSync(path, 'utf-8')
						const disk = parse(raw) as Record<string, unknown>
						Object.assign(data, disk)
					} catch {}
				}, 50)
			})
		} catch {}
	}

	const handler: ProxyHandler<any> = {
		set(target, prop, value) {
			target[prop] = value
			dirty = true
			scheduleFlush()
			return true
		},
		get(target, prop) {
			if (prop === 'save') return flush
			const val = target[prop]
			if (val && typeof val === 'object') return new Proxy(val, handler)
			return val
		},
	}

	const proxy = new Proxy(data, handler)

	return proxy as T & { save(): void }
}
