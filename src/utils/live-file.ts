// Keep a plain object synced with an ASON file. Mutations write back on the next
// microtask, and optional watching patches external edits into the same object.

import { readFileSync, writeFileSync, renameSync, existsSync, watch } from 'fs'
import { dirname } from 'path'
import { ason } from './ason.ts'

interface LiveState {
	path: string
	data: Record<string, any>
	dirty: boolean
	flushScheduled: boolean
	callbacks: Array<() => void>
	// Hold the watcher on the state object itself so the runtime does not lose it to GC.
	watcher: ReturnType<typeof watch> | null
	doFlush: () => void
}

const registry = new WeakMap<object, LiveState>()

function liveFile<T extends Record<string, any>>(path: string, defaults: T, opts?: { watch?: boolean }): T {
	const data: Record<string, any> = { ...defaults }
	if (existsSync(path)) {
		try {
			Object.assign(data, ason.parse(readFileSync(path, 'utf-8'), { comments: true }) as any)
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

	if (opts?.watch !== false) {
		let debounce: ReturnType<typeof setTimeout> | null = null
		let ownWrite = false
		const origFlush = state.doFlush
		state.doFlush = () => {
			ownWrite = true
			origFlush()
			// Keep ownWrite true long enough for the debounced directory watch to notice it.
			setTimeout(() => {
				ownWrite = false
			}, 100)
		}
		try {
			// Watch the directory so tmp+rename writes from us or an editor do not break the watch.
			state.watcher = watch(dirname(path), { persistent: false }, () => {
				if (ownWrite) return
				if (debounce) clearTimeout(debounce)
				debounce = setTimeout(() => {
					try {
						const next = ason.parse(readFileSync(path, 'utf-8'), { comments: true }) as Record<string, any>
						const before = ason.stringify(data)
						const after = ason.stringify(next)
						if (before === after) return
						// Mutate in place so existing proxies keep pointing at fresh data.
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
