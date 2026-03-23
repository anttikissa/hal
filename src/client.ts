// Client -- state manager for tabs, entries, prompt.
// Display-agnostic: a terminal CLI or web UI can drive this.

import { appendCommand, tailEvents, readAllEvents } from './ipc.ts'

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

// ── State ────────────────────────────────────────────────────────────────────

// Mutable state object. Importers read and write fields directly.
export const state = {
	tabs: [] as Tab[],
	activeTab: 0,
	promptText: '',
	promptCursor: 0,
	role: 'server' as 'server' | 'client',
}

// Callback: display layer sets this so state changes trigger repaint.
let onChange: (force: boolean) => void = () => {}

export function setOnChange(fn: (force: boolean) => void): void {
	onChange = fn
}

// ── Tab helpers ──────────────────────────────────────────────────────────────

export function currentTab(): Tab | null {
	return state.tabs[state.activeTab] ?? null
}

export function switchTab(index: number): void {
	if (index >= 0 && index < state.tabs.length && index !== state.activeTab) {
		state.activeTab = index
		onChange(true)
	}
}

export function nextTab(): void {
	if (state.tabs.length > 0) switchTab((state.activeTab + 1) % state.tabs.length)
}

export function prevTab(): void {
	if (state.tabs.length > 0) switchTab((state.activeTab - 1 + state.tabs.length) % state.tabs.length)
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function addEntry(text: string, type: EntryType = 'info'): void {
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

export function setPrompt(text: string, cursor: number): void {
	state.promptText = text
	state.promptCursor = cursor
	onChange(false)
}

export function clearPrompt(): void {
	state.promptText = ''
	state.promptCursor = 0
	onChange(false)
}

// ── IPC ──────────────────────────────────────────────────────────────────────

export function sendCommand(type: string, text?: string): void {
	const tab = currentTab()
	appendCommand({ type, text, sessionId: tab?.sessionId })
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

export function startClient(signal: AbortSignal): void {
	for (const event of eventsForCurrentRuntime(readAllEvents())) {
		handleEvent(event)
	}
	void (async () => {
		for await (const event of tailEvents(signal)) {
			handleEvent(event)
		}
	})()
}
