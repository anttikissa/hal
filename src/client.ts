// Client -- state manager for tabs, entries, prompt.
// Display-agnostic: a terminal CLI or web UI can drive this.

import { ipc } from './ipc.ts'
import { sessions as sessionStore } from './server/sessions.ts'
import { perf } from './perf.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export type EntryType = 'input' | 'assistant' | 'info'

export interface Entry {
	type: EntryType
	text: string
	ts?: number
}

export interface Tab {
	sessionId: string
	name: string
	history: Entry[]
}

// ── Internal state ───────────────────────────────────────────────────────────

const state = {
	tabs: [] as Tab[],
	activeTab: 0,
	promptText: '',
	promptCursor: 0,
	role: 'server' as 'server' | 'client',
}

let onChange: (force: boolean) => void = () => {}

// ── Functions ────────────────────────────────────────────────────────────────

function setOnChange(fn: (force: boolean) => void): void {
	onChange = fn
}

function currentTab(): Tab | null {
	return state.tabs[state.activeTab] ?? null
}

function switchTab(index: number): void {
	if (index >= 0 && index < state.tabs.length && index !== state.activeTab) {
		state.activeTab = index
		onChange(true)
	}
}

function nextTab(): void {
	if (state.tabs.length > 0) switchTab((state.activeTab + 1) % state.tabs.length)
}

function prevTab(): void {
	if (state.tabs.length > 0) switchTab((state.activeTab - 1 + state.tabs.length) % state.tabs.length)
}

function addEntry(text: string, type: EntryType = 'info'): void {
	const tab = currentTab()
	if (tab) {
		tab.history.push({ type, text, ts: Date.now() })
		onChange(false)
	}
}

function addEntryToTab(sessionId: string | null, entry: Entry): void {
	let tab = sessionId ? state.tabs.find(t => t.sessionId === sessionId) : currentTab()
	if (!tab) tab = currentTab()
	if (tab) {
		tab.history.push(entry)
		onChange(false)
	}
}

function setPrompt(text: string, cursor: number): void {
	state.promptText = text
	state.promptCursor = cursor
	onChange(false)
}

function clearPrompt(): void {
	state.promptText = ''
	state.promptCursor = 0
	onChange(false)
}

function sendCommand(type: string, text?: string): void {
	const tab = currentTab()
	ipc.appendCommand({ type, text, sessionId: tab?.sessionId })
}

function handleEvent(event: any): void {
	if (event.type === 'runtime-start' || event.type === 'host-released') return

	if (event.type === 'sessions') {
		const newTabs: Tab[] = []
		for (const s of event.sessions) {
			const existing = state.tabs.find(t => t.sessionId === s.id)
			if (existing) {
				existing.name = s.name
				newTabs.push(existing)
			} else {
				newTabs.push({ sessionId: s.id, name: s.name, history: [] })
			}
		}
		const grew = newTabs.length > state.tabs.length
		state.tabs = newTabs
		if (state.activeTab >= state.tabs.length) state.activeTab = state.tabs.length - 1
		if (grew) state.activeTab = state.tabs.length - 1
		onChange(false)
	} else if (event.type === 'prompt') {
		addEntryToTab(event.sessionId, {
			type: 'input', text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'response') {
		addEntryToTab(event.sessionId, {
			type: 'assistant', text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'info') {
		addEntryToTab(event.sessionId ?? null, {
			type: 'info', text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	}
}

function eventsForCurrentRuntime(events: any[]): any[] {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.type === 'runtime-start') return events.slice(i + 1)
	}
	return events
}

function loadPersistedSessions(): void {
	const loaded = sessionStore.loadAllSessions()
	if (loaded.length === 0) return

	const newTabs: Tab[] = []
	for (const s of loaded) {
		const name = s.meta.topic ?? `tab ${newTabs.length + 1}`
		const history: Entry[] = s.entries.map(e => ({
			type: e.type,
			text: e.text,
			ts: e.ts,
		}))
		newTabs.push({ sessionId: s.meta.id, name, history })
	}
	state.tabs = newTabs
	state.activeTab = 0
	perf.mark(`Client loaded ${loaded.length} sessions`)
}

function startClient(signal: AbortSignal): void {
	// Load persisted sessions directly from disk (fast, no IPC roundtrip).
	loadPersistedSessions()

	for (const event of eventsForCurrentRuntime(ipc.readAllEvents())) {
		handleEvent(event)
	}
	onChange(false)
	void (async () => {
		for await (const event of ipc.tailEvents(signal)) {
			handleEvent(event)
		}
	})()
}

// ── Namespace ────────────────────────────────────────────────────────────────

export const client = {
	state, setOnChange, currentTab, switchTab, nextTab, prevTab,
	addEntry, setPrompt, clearPrompt, sendCommand, startClient,
}
