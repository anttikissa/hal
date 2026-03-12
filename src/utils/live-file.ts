// liveFile — proxy-backed auto-persist object.
//
// Quick, dirty and dangerous.
//
// Usage:
//
// let config = liveFile('config.ason', {})
// config.foo = 1                // saved on next microtask
// config.bar.zot = 2            // (only one atomic write)
//
// (external change to config.ason changes bar.zot to 3):
//
// console.log(config.bar.zot)   // 3
//
// CAVEATS:
//
// Don't stash nested objects:
//
//   const f = liveFile('file.ason', { defaults: { foo: { bar: 1 } } })
//   const bad = f.foo       // proxy around current data.foo
//   // ...time passes, file reloads from disk (fs.watch / external edit)...
//   bad.bar = 2             // SILENTLY LOST — bad wraps the old object,
//                           // but data.foo is now a new object from disk.
//                           // dirty flag fires, but flush writes data (with new foo).
//
// Safe pattern: always access through the root proxy.
//
//   f.foo.bar = 2           // ✅ f.foo re-fetches data.foo each time
//
// If file is written with parse errors, all bets are off
//

import { writeFileSync, renameSync, watch, existsSync } from 'fs'
import { ason } from './ason.ts'
import { readFiles } from './read-file.ts'
import { state } from '../state.ts'
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
			const raw = readFiles.readTextSync(path, 'liveFile.load')
			data = { ...opts.defaults, ...(ason.parse(raw) as Record<string, unknown>) }
		} catch {}
	}

	let flush = (): void => {
		if (!dirty) return
		dirty = false
		state.ensureDir(dirname(path))
		const tmp = `${path}.tmp.${process.pid}`
		writeFileSync(tmp, ason.stringify(data) + '\n')
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
						const raw = readFiles.readTextSync(path, 'liveFile.watchReload')
						const disk = ason.parse(raw) as Record<string, unknown>
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

export const liveFiles = { liveFile }
