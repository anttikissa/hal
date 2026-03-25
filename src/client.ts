// Client -- state manager for tabs, entries, prompt.
// Display-agnostic: a terminal CLI or web UI can drive this.

import { readFileSync, writeFileSync } from 'fs'
import { ipc } from './ipc.ts'
import { sessions as sessionStore } from './server/sessions.ts'
import { replay } from './session/replay.ts'
import { draft as draftModule } from './cli/draft.ts'
import { perf } from './perf.ts'
import { STATE_DIR } from './state.ts'
import { ason } from './utils/ason.ts'

// ── Types ────────────────────────────────────────────────────────────────────

import { blocks as blockModule } from './cli/blocks.ts'
import type { Block } from './cli/blocks.ts'
import type { HistoryEntry } from './server/sessions.ts'
export type { Block }

export interface Tab {
	sessionId: string
	name: string
	history: Block[]
	// Per-tab prompt history for up-arrow recall. Extracted from session
	// history entries on load, appended to on each prompt submission.
	inputHistory: string[]
	// In-memory mirror of the draft.ason on disk. Kept in sync so we
	// can hand it to the CLI on tab switch without a disk read.
	inputDraft: string
	// Tabs start unloaded: raw history is stashed here and converted to
	// blocks on demand (active tab at startup, others in background).
	rawHistory?: HistoryEntry[]
	loaded: boolean
	// Generation finished on a non-active tab — show ✓ until user switches to it
	doneUnseen: boolean
}

// ── Internal state ───────────────────────────────────────────────────────────

const config = {
	backgroundLoadTabs: true,
	backgroundLoadBlobs: true,
	repaintAfterBlobLoad: true,
}

const state = {
	tabs: [] as Tab[],
	activeTab: 0,
	promptText: '',
	promptCursor: 0,
	role: 'server' as 'server' | 'client',
	// Persisted across restarts so the prompt stays at a stable position.
	// Invalidated if terminal width changed since last save.
	peak: 0,
	peakCols: 0,
	// Current model selection, persisted across restarts
	model: null as string | null,
	// Busy state per session — true while agent is generating/running tools
	busy: new Map<string, boolean>(),
	// Activity text per session — "generating...", "running 3 tool(s)...", etc.
	activity: new Map<string, string>(),
}

let onChange: (force: boolean) => void = () => {}

// ── Functions ────────────────────────────────────────────────────────────────

function setOnChange(fn: (force: boolean) => void): void {
	onChange = fn
}

function currentTab(): Tab | null {
	return state.tabs[state.activeTab] ?? null
}

function isBusy(): boolean {
	const tab = currentTab()
	return tab ? (state.busy.get(tab.sessionId) ?? false) : false
}

function getActivity(): string {
	const tab = currentTab()
	return tab ? (state.activity.get(tab.sessionId) ?? '') : ''
}

// onTabSwitch callback — set by CLI to save/restore drafts on tab change
let onTabSwitch: ((fromSession: string, toSession: string) => void) | null = null

function setOnTabSwitch(fn: (from: string, to: string) => void): void {
	onTabSwitch = fn
}

// onDraftArrived callback — fired when another client saves a draft for
// the active tab and our prompt is empty. The CLI uses this to show the
// draft text (e.g. client A quits with a draft, client B picks it up).
let onDraftArrived: ((text: string) => void) | null = null

function setOnDraftArrived(fn: (text: string) => void): void {
	onDraftArrived = fn
}

function switchTab(index: number): void {
	if (index >= 0 && index < state.tabs.length && index !== state.activeTab) {
		const fromSession = state.tabs[state.activeTab]?.sessionId ?? ''
		state.activeTab = index
		const tab = state.tabs[index]!
		// Clear "done unseen" flag — user is now looking at this tab
		tab.doneUnseen = false
		ensureTabLoaded(tab)
		// Re-read draft from disk — another client may have saved one
		const diskDraft = draftModule.loadDraft(tab.sessionId)
		if (diskDraft && !tab.inputDraft) tab.inputDraft = diskDraft
		if (onTabSwitch) onTabSwitch(fromSession, tab.sessionId)
		saveClientState()
		onChange(true)
	}
}

// Convert raw history → blocks if not already done.
// Called on tab switch and during background loading.
// Also extracts per-tab input history for up-arrow recall.
function ensureTabLoaded(tab: Tab): void {
	if (tab.loaded) return
	tab.inputHistory = replay.inputHistoryFromEntries(tab.rawHistory!)
	tab.history = blockModule.historyToBlocks(tab.rawHistory!, tab.sessionId)
	tab.rawHistory = undefined
	tab.loaded = true
}

// ── Last-tab persistence ─────────────────────────────────────────────────────

const CLIENT_STATE_PATH = `${STATE_DIR}/client.ason`

interface ClientStateFile {
	lastTab: string | null
	peak: number // high-water mark for rendered line count
	peakCols: number // terminal width peak was computed at
	model: string | null // last-used model, restored on startup
}

function loadClientState(): ClientStateFile {
	try {
		const data = ason.parse(readFileSync(CLIENT_STATE_PATH, 'utf-8')) as any
		return {
			lastTab: data?.lastTab ?? null,
			peak: data?.peak ?? 0,
			peakCols: data?.peakCols ?? 0,
			model: data?.model ?? null,
		}
	} catch {
		return { lastTab: null, peak: 0, peakCols: 0, model: null }
	}
}

function saveClientState(): void {
	const tab = currentTab()
	try {
		writeFileSync(
			CLIENT_STATE_PATH,
			ason.stringify({
				lastTab: tab?.sessionId ?? null,
				peak: state.peak,
				peakCols: state.peakCols,
				model: state.model,
			}) + '\n',
		)
	} catch {}
}

// ── Per-tab prompt history ──────────────────────────────────────────────────
// Each tab has its own inputHistory[]. On tab switch the CLI calls
// getInputHistory() and passes the result to prompt.setHistory().
// No separate file — history is reconstructed from session history entries.

function getInputHistory(): string[] {
	return currentTab()?.inputHistory ?? []
}

function appendInputHistory(line: string): void {
	const tab = currentTab()
	if (!tab || !line.trim()) return
	tab.inputHistory.push(line)
}

// ── Per-tab draft ────────────────────────────────────────────────────────────

function getInputDraft(): string {
	return currentTab()?.inputDraft ?? ''
}

// Save draft text to memory + disk + IPC notification.
function saveDraft(draftText: string): void {
	const tab = currentTab()
	if (!tab) return
	tab.inputDraft = draftText
	draftModule.saveDraft(tab.sessionId, draftText)
}

// Clear draft (called on submit).
function clearDraft(): void {
	const tab = currentTab()
	if (!tab) return
	tab.inputDraft = ''
	draftModule.clearDraft(tab.sessionId)
}

// Called on submit — clear draft and update history.
function onSubmit(text: string): void {
	appendInputHistory(text)
	clearDraft()
}

function nextTab(): void {
	if (state.tabs.length > 0) switchTab((state.activeTab + 1) % state.tabs.length)
}

function prevTab(): void {
	if (state.tabs.length > 0) switchTab((state.activeTab - 1 + state.tabs.length) % state.tabs.length)
}

function addEntry(text: string, type: 'info' | 'error' = 'info'): void {
	const tab = currentTab()
	if (tab) {
		tab.history.push({ type, text, ts: Date.now() })
		onChange(false)
	}
}

function addBlockToTab(sessionId: string | null, block: Block): void {
	let tab = sessionId ? state.tabs.find((t) => t.sessionId === sessionId) : currentTab()
	if (!tab) tab = currentTab()
	if (tab) {
		tab.history.push(block)
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

// Track pending open/fork so we know to copy draft on fork
let pendingOpen: 'open' | 'fork' | false = false

function sendCommand(type: string, text?: string): void {
	const tab = currentTab()
	if (type === 'open') pendingOpen = 'open'
	if (type === 'fork') pendingOpen = 'fork'
	ipc.appendCommand({ type, text, sessionId: tab?.sessionId })
}

function handleEvent(event: any): void {
	if (event.type === 'runtime-start' || event.type === 'host-released') return

	if (event.type === 'sessions') {
		const newTabs: Tab[] = []
		const isFork = pendingOpen === 'fork'
		for (const s of event.sessions) {
			const existing = state.tabs.find((t) => t.sessionId === s.id)
			if (existing) {
				existing.name = s.name
				newTabs.push(existing)
			} else {
				newTabs.push({ sessionId: s.id, name: s.name, history: [], inputHistory: [], inputDraft: '', loaded: true, doneUnseen: false })
			}
		}
		const grew = newTabs.length > state.tabs.length
		const prevSession = state.tabs[state.activeTab]?.sessionId ?? ''
		state.tabs = newTabs
		if (state.activeTab >= state.tabs.length) state.activeTab = state.tabs.length - 1
		if (grew) state.activeTab = state.tabs.length - 1
		const newSession = state.tabs[state.activeTab]?.sessionId ?? ''
		// On fork, copy the parent's draft to the new tab
		if (isFork && grew && prevSession) {
			const prevTab = newTabs.find(t => t.sessionId === prevSession)
			const newTab = newTabs[state.activeTab]
			if (prevTab?.inputDraft && newTab) newTab.inputDraft = prevTab.inputDraft
		}
		pendingOpen = false
		// When active tab changes (e.g. new tab added), save/restore drafts
		if (prevSession !== newSession && onTabSwitch) onTabSwitch(prevSession, newSession)
		onChange(false)
	} else if (event.type === 'prompt') {
		addBlockToTab(event.sessionId, {
			type: 'user',
			text: event.text,
			status: event.label, // 'steering' when typed during generation
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'response') {
		addBlockToTab(event.sessionId, {
			type: event.isError ? 'error' : 'assistant',
			text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'info') {
		addBlockToTab(event.sessionId ?? null, {
			type: 'info',
			text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'status' && event.sessionId) {
		const wasBusy = state.busy.get(event.sessionId) ?? false
		const nowBusy = event.busy ?? false
		state.busy.set(event.sessionId, nowBusy)
		state.activity.set(event.sessionId, event.activity ?? '')
		// Generation just finished on a background tab → mark as done-unseen
		if (wasBusy && !nowBusy) {
			const activeSession = currentTab()?.sessionId
			if (event.sessionId !== activeSession) {
				const tab = state.tabs.find(t => t.sessionId === event.sessionId)
				if (tab) tab.doneUnseen = true
			}
		}
		onChange(false)
	} else if (event.type === 'tool-call' && event.sessionId) {
		addBlockToTab(event.sessionId, {
			type: 'tool',
			name: event.name,
			input: event.input,
			toolId: event.toolId,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'tool-result' && event.sessionId) {
		// Find the tool block and update it with output
		const tab = state.tabs.find((t) => t.sessionId === event.sessionId)
		if (tab) {
			const toolBlock = tab.history.find((b: any) => b.type === 'tool' && b.toolId === event.toolId) as any
			if (toolBlock) {
				toolBlock.output = event.output
				onChange(false)
			}
		}
	} else if (event.type === 'draft_saved' && event.sessionId) {
		// Another client saved a draft. Update the in-memory copy for that
		// tab. If it's the active tab and our prompt is empty, show it.
		const tab = state.tabs.find(t => t.sessionId === event.sessionId)
		if (tab) {
			const text = draftModule.loadDraft(event.sessionId)
			tab.inputDraft = text
			const active = currentTab()
			if (active?.sessionId === event.sessionId && onDraftArrived) {
				onDraftArrived(text)
			}
		}
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

	// Create tabs with raw history stashed — don't convert to blocks yet.
	// inputHistory starts empty; ensureTabLoaded() populates it from rawHistory.
	const newTabs: Tab[] = []
	for (const s of loaded) {
		const dirName = s.meta.workingDir?.split('/').pop()
		const name = s.meta.topic ?? dirName ?? `tab ${newTabs.length + 1}`
		newTabs.push({
			sessionId: s.meta.id,
			name,
			history: [],
			inputHistory: [],
			inputDraft: '',
			rawHistory: s.history,
			loaded: false,
			doneUnseen: false,
		})
	}
	state.tabs = newTabs

	// Restore persisted client state (last tab, peak, model).
	const saved = loadClientState()
	const lastIdx = saved.lastTab ? newTabs.findIndex((t) => t.sessionId === saved.lastTab) : -1
	state.activeTab = lastIdx >= 0 ? lastIdx : 0
	if (saved.model) state.model = saved.model

	// Only load the active tab now — first paint needs it.
	// Other tabs are loaded in the background after first paint.
	const active = state.tabs[state.activeTab]
	if (active) {
		ensureTabLoaded(active)
		active.inputDraft = draftModule.loadDraft(active.sessionId)
	}

	const cols = process.stdout.columns || 80
	if (saved.peakCols === cols && saved.peak > 0) {
		state.peak = saved.peak
	}
	state.peakCols = cols
	perf.mark(`Client loaded ${loaded.length} sessions (1 active)`)
}

// Background loader: runs after first paint.
// 1. Load blobs for active tab's tool blocks (so titles + output appear)
// 2. Convert remaining tabs from raw history → blocks
// 3. Load blobs for each remaining tab
// All async with parallel I/O — UI stays responsive throughout.
async function loadInBackground(): Promise<void> {
	// Active tab's blobs first — user is looking at this tab
	if (config.backgroundLoadBlobs) {
		const active = state.tabs[state.activeTab]
		if (active) {
			const n = await blockModule.loadToolBlobs(active.history)
			if (n > 0 && config.repaintAfterBlobLoad) onChange(false)
		}
	}

	if (!config.backgroundLoadTabs) return

	// Remaining tabs: convert history then load blobs
	for (const tab of state.tabs) {
		if (!tab.loaded) ensureTabLoaded(tab)
		if (config.backgroundLoadBlobs) {
			const n = await blockModule.loadToolBlobs(tab.history)
			if (n > 0 && tab === state.tabs[state.activeTab]) onChange(false)
		}
	}
	perf.mark('All tabs loaded')
}

function startClient(signal: AbortSignal): void {
	// Load persisted sessions directly from disk (fast, no IPC roundtrip).
	loadPersistedSessions()

	for (const event of eventsForCurrentRuntime(ipc.readAllEvents())) {
		handleEvent(event)
	}
	onChange(false)

	// Background-load blobs + remaining tabs after first paint
	void loadInBackground()

	void (async () => {
		for await (const event of ipc.tailEvents(signal)) {
			handleEvent(event)
		}
	})()
}

// ── Namespace ────────────────────────────────────────────────────────────────

export const client = {
	config,
	state,
	setOnChange,
	setOnTabSwitch,
	setOnDraftArrived,
	currentTab,
	isBusy,
	getActivity,
	switchTab,
	nextTab,
	prevTab,
	addEntry,
	setPrompt,
	clearPrompt,
	sendCommand,
	startClient,
	saveState: saveClientState,
	getInputHistory,
	appendInputHistory,
	getInputDraft,
	saveDraft,
	clearDraft,
	onSubmit,
}
