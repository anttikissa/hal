// Host-facing transient search. Disk, ASON parsing and SQLite all live in
// a worker; even a single enormous history record cannot stall typing.
import type { FindBatch, FindFilter, FindResult } from '../common/find.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'

type Listener = { channel: string; request: string; deliver: (batch: FindBatch) => void }

function init(): void {
	if (find.state.worker) return
	let worker = new Worker(new URL('./find-worker.ts', import.meta.url).href)
	find.state.worker = worker
	worker.onmessage = (event) => {
		let data = event.data
		if (data.error) { find.fail(data.error); return }
		if (data.indexed) { find.indexed(); return }
		if (!data.batch) return
		for (let listener of find.state.listeners.values()) {
			if (listener.channel === data.channel && listener.request === data.batch.request) listener.deliver(data.batch)
		}
	}
	worker.onerror = (event) => find.fail(event.message)
	worker.postMessage({ type: 'init', home: paths.home() })
	// Observe durable append without adding parsing/indexing to its path.
	let append = history.append
	history.append = (id, record) => { let full = append(id, record); find.dirty(id); return full }
	find.state.undo = () => { history.append = append }
}

// Session meta is a live-file proxy (nested proxies too): postMessage
// cannot clone it, and the throw would kill the host. Send plain data.
function plain<T>(meta: T): T { return meta === undefined ? meta : JSON.parse(JSON.stringify(meta)) }

function dirty(sessionId: string): void {
	find.state.dirty.add(sessionId)
	if (find.state.timer) return
	find.state.timer = setTimeout(() => {
		find.state.timer = undefined
		for (let id of find.state.dirty) find.state.worker?.postMessage({ type: 'dirty', sessionId: id, meta: plain(sessions.state.open.get(id)) })
		find.state.dirty.clear()
	}, 0)
}

function search(owner: object, request: string, query: string, kinds: FindFilter[] | undefined, deliver: (batch: FindBatch) => void): void {
	find.init()
	if (find.state.error) { deliver({ type: 'find-results', request, tier: 'metadata', results: [], done: true, error: find.state.error }); return }
	let channel = find.state.listeners.get(owner)?.channel ?? String(++find.state.serial)
	find.state.listeners.set(owner, { channel, request, deliver })
	find.state.worker!.postMessage({ type: 'search', channel, request, query, kinds, meta: [...sessions.state.open.values()].map(plain) })
}

function cancel(owner: object): void {
	let listener = find.state.listeners.get(owner)
	if (listener) find.state.worker?.postMessage({ type: 'cancel', channel: listener.channel })
	find.state.listeners.delete(owner)
}

function top(query: string): Promise<FindResult[]> {
	return new Promise((resolve, reject) => {
		let owner = {}, tiers = new Map<string, FindResult[]>()
		find.search(owner, crypto.randomUUID(), query, undefined, (batch) => {
			if (batch.error) { find.cancel(owner); reject(new Error(batch.error)); return }
			if (!batch.done) tiers.set(batch.tier, batch.results)
			if (batch.done) { find.cancel(owner); resolve([...tiers.values()].flat().sort((a, b) => b.score - a.score || a.age - b.age).slice(0, 20)) }
		})
	})
}

function fail(error: string): void {
	diag.log(`find: ${error}`)
	find.state.error = error
	for (let listener of find.state.listeners.values()) listener.deliver({ type: 'find-results', request: listener.request, tier: 'metadata', results: [], done: true, error })
}

function reset(): void {
	find.state.worker?.terminate()
	find.state.worker = undefined
	find.state.error = undefined
	find.state.undo?.(); find.state.undo = undefined
	clearTimeout(find.state.timer); find.state.timer = undefined
	find.state.listeners.clear(); find.state.dirty.clear()
}

export const find = {
	state: { worker: undefined as Worker | undefined, error: undefined as string | undefined, listeners: new Map<object, Listener>(), serial: 0, dirty: new Set<string>(), timer: undefined as ReturnType<typeof setTimeout> | undefined, undo: undefined as (() => void) | undefined },
	init, dirty, search, cancel, top, fail, reset,
	indexed: (): void => {},
}
