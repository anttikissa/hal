/*
Usage:

```ts
import { liveFiles } from './utils/live-file.ts'

const data = liveFiles.liveFile('/tmp/settings.ason', { enabled: true })

data.enabled = false // writes /tmp/settings.ason on the next microtask

liveFiles.save(data) // force an immediate write when you need disk synced now

liveFiles.onChange(data, (change) => {
	// Fired after an external edit is reloaded into the same live object.
	const changedPath = change.path
	const previousValue = change.previous.enabled
	const nextValue = change.next.enabled
})
```
*/
// Keep a plain object synced with an ASON file. Mutations write back on the next
// microtask, and optional watching patches external edits into the same object.

import { readFileSync, writeFileSync, renameSync, watch } from 'fs'
import { dirname } from 'path'
import { ason } from './ason.ts'

interface LiveFileChange {
	path: string
	previous: Record<string, any>
	next: Record<string, any>
}

type LiveFileChangeCallback = (change: LiveFileChange) => void


interface LiveState {
	path: string
	data: Record<string, any>
	dirty: boolean
	flushScheduled: boolean
	callbacks: LiveFileChangeCallback[]
	// Hold the watcher on the state object itself so the runtime does not lose it to GC.
	watcher: ReturnType<typeof watch> | null
	doFlush: () => void
}

const registry = new WeakMap<object, LiveState>()

function snapshot(value: Record<string, any>): Record<string, any> {
	// Defaults can come from another liveFile, which means nested values may be
	// proxies. structuredClone() rejects proxies; ASON roundtrips them as plain
	// data, matching what live files can persist anyway.
	return ason.parse(ason.stringify(value), { comments: true }) as Record<string, any>
}

function loadFromDisk(path: string, data: Record<string, any>, notify = false, callbacks: LiveFileChangeCallback[] = [], replace = true): void {
	try {
		const next = ason.parse(readFileSync(path, 'utf-8'), { comments: true }) as Record<string, any>
		if (ason.stringify(data) === ason.stringify(next)) return
		let change: LiveFileChange | null = null
		if (notify) change = { path, previous: snapshot(data), next: snapshot(next) }
		// Mutate in place so existing proxies keep pointing at fresh data.
		if (replace) for (const key of Object.keys(data)) {
			if (!(key in next)) delete data[key]
		}
		Object.assign(data, next)
		if (change) for (const cb of callbacks) cb(change)
	} catch {}
}
function liveFile<T extends Record<string, any>>(path: string, defaults: T, opts?: { watch?: boolean }): T {
	const data: Record<string, any> = { ...defaults }
	loadFromDisk(path, data, false, [], false)

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
					loadFromDisk(path, data, true, state.callbacks)
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

function reload<T extends object>(proxy: T): T {
	const state = registry.get(proxy)
	if (state) loadFromDisk(state.path, state.data)
	return proxy
}

function onChange(proxy: object, cb: LiveFileChangeCallback): void
function onChange(proxy: object, cb: () => void): void
function onChange(proxy: object, cb: LiveFileChangeCallback): void {
	registry.get(proxy)?.callbacks.push(cb)
}

export const liveFiles = { liveFile, save, reload, onChange }
