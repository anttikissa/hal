// liveFile — proxy-backed auto-persist object with file watching.
//
// Usage:
//   const data = liveFile('state/foo.ason', { count: 0, name: 'default' })
//   data.count++                       // auto-saved on next microtask
//   data.name = 'bar'                  // coalesced into one write
//
//   liveFiles.save(data)               // force immediate flush
//   liveFiles.onChange(data, () => {})  // called on external file change
//
// save() and onChange() are standalone functions keyed by proxy reference
// (WeakMap), so liveFile objects stay clean — no magic properties that
// could collide with user data.
//
// CAVEAT: don't stash nested objects — always access through the root
// proxy so you get the latest data after file reloads.

import { readFileSync, writeFileSync, renameSync, existsSync, watch } from 'fs'
import { dirname, basename } from 'path'
import { ason } from './ason.ts'

interface LiveState {
	path: string
	data: Record<string, any>
	dirty: boolean
	flushScheduled: boolean
	callbacks: Array<() => void>
	// Keep the watcher alive for as long as the proxy is reachable.
	// If we drop this reference, Bun/Node may GC the fs.watch handle and
	// external edits stop arriving intermittently.
	watcher: ReturnType<typeof watch> | null
	doFlush: () => void
}

const registry = new WeakMap<object, LiveState>()

function liveFile<T extends Record<string, any>>(path: string, defaults: T, opts?: { watch?: boolean }): T {
	const data: Record<string, any> = { ...defaults }

	// Load from disk, merging over defaults
	if (existsSync(path)) {
		try {
			Object.assign(data, ason.parse(readFileSync(path, 'utf-8')) as any)
		} catch {}
	}

	const state: LiveState = {
		path,
		data,
		dirty: false,
		flushScheduled: false,
		callbacks: [],
		watcher: null,
		doFlush() {
			if (!state.dirty) return
			state.dirty = false
			const tmp = `${path}.tmp.${process.pid}`
			writeFileSync(tmp, ason.stringify(data) + '\n')
			renameSync(tmp, path)
		},
	}

	function scheduleFlush(): void {
		if (state.flushScheduled) return
		state.flushScheduled = true
		queueMicrotask(() => {
			state.flushScheduled = false
			state.doFlush()
		})
	}

	// Watch directory (not file) so atomic tmp+rename doesn't kill the watcher.
	// Debounce to coalesce rapid changes.
	if (opts?.watch !== false) {
		let debounce: ReturnType<typeof setTimeout> | null = null
		let ownWrite = false
		const origFlush = state.doFlush
		state.doFlush = () => {
			ownWrite = true
			origFlush()
			// Hold the flag longer than the watch debounce (50ms)
			// so the fs.watch callback sees it and skips the reload.
			setTimeout(() => {
				ownWrite = false
			}, 100)
		}
		try {
			state.watcher = watch(dirname(path), { persistent: false }, () => {
				if (ownWrite) return
				if (debounce) clearTimeout(debounce)
				debounce = setTimeout(() => {
					try {
						const next = ason.parse(readFileSync(path, 'utf-8')) as Record<string, any>
						const before = ason.stringify(data)
						const after = ason.stringify(next)
						if (before === after) return
						// Replace the object in place so existing proxies keep working,
						// while also dropping keys removed from the file.
						for (const key of Object.keys(data)) {
							if (!(key in next)) delete data[key]
						}
						Object.assign(data, next)
						for (const cb of state.callbacks) cb()
					} catch {}
				}, 50)
			})
		} catch {}
	}

	// Recursive proxy: sets mark dirty and schedule flush.
	// Gets return nested proxies for objects so deep mutations auto-save.
	const handler: ProxyHandler<any> = {
		set(target, prop, value) {
			target[prop] = value
			state.dirty = true
			scheduleFlush()
			return true
		},
		get(target, prop) {
			const val = target[prop]
			if (val && typeof val === 'object' && !Array.isArray(val)) {
				return new Proxy(val, handler)
			}
			return val
		},
	}

	const proxy = new Proxy(data, handler) as T
	registry.set(proxy, state)
	return proxy
}

function save(proxy: object): void {
	registry.get(proxy)?.doFlush()
}

function onChange(proxy: object, cb: () => void): void {
	registry.get(proxy)?.callbacks.push(cb)
}

export const liveFiles = { liveFile, save, onChange }
