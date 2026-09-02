interface DraftStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

const config = { storagePrefix: 'hal-web-draft:' }
// Failed writes stay in memory, and the reconnect path refuses to reload while
// this map is non-empty. Storage failure is visible instead of silently destructive.
const state = { pending: new Map<string, string | null>() }

function browserStorage(): DraftStorage | undefined {
	try {
		return localStorage
	} catch {
		return undefined
	}
}

function storageKey(sessionId: string): string {
	return `${webDraft.config.storagePrefix}${sessionId}`
}

function load(sessionId: string, storage = webDraft.browserStorage()): string {
	if (webDraft.state.pending.has(sessionId)) return webDraft.state.pending.get(sessionId) ?? ''
	try {
		return storage?.getItem(webDraft.storageKey(sessionId)) ?? ''
	} catch {
		return ''
	}
}

function persist(sessionId: string, text: string | null, storage = webDraft.browserStorage()): boolean {
	webDraft.state.pending.set(sessionId, text)
	try {
		if (!storage) return false
		if (text === null || !text) storage.removeItem(webDraft.storageKey(sessionId))
		else storage.setItem(webDraft.storageKey(sessionId), text)
		webDraft.state.pending.delete(sessionId)
		return true
	} catch {
		return false
	}
}

// Save on every input event. localStorage is deliberately synchronous: when iOS
// kills or reloads the page, the final keystroke must already be durable.
function save(sessionId: string, text: string, storage = webDraft.browserStorage()): boolean {
	webDraft.persist(sessionId, text, storage)
	if (!webDraft.isDurable()) webDraft.flush(storage)
	return webDraft.isDurable()
}

// A send can finish after the user has typed more. Only remove the exact text
// that was sent, never a newer draft written while the request was in flight.
function clearIfUnchanged(sessionId: string, sentText: string, storage = webDraft.browserStorage()): boolean {
	if (webDraft.load(sessionId, storage) !== sentText) return false
	webDraft.persist(sessionId, null, storage)
	return true
}

function isDurable(): boolean {
	return webDraft.state.pending.size === 0
}

function flush(storage = webDraft.browserStorage()): boolean {
	for (const [sessionId, text] of [...webDraft.state.pending]) webDraft.persist(sessionId, text, storage)
	return webDraft.isDurable()
}

export const webDraft = { config, state, browserStorage, storageKey, load, persist, save, clearIfUnchanged, isDurable, flush }
