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
import { liveFiles } from './utils/live-file.ts'

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
	// Bumped whenever history contents change. The renderer uses this to
	// invalidate cached line counts when a block grows in place.
	historyVersion: number
	// Cumulative token usage for this session (input + output).
	// Accumulated from stream-end events and loaded from history on startup.
	usage: { input: number; output: number }
	// Last known context window usage (estimated tokens used / max).
	// Updated from stream-end events.
	contextUsed: number
	contextMax: number
	// Working directory and model for this session.
	// Updated from sessions broadcast events.
	cwd: string
	model: string
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
	pid: process.pid,
	hostPid: null as number | null,
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

let pendingEntries: Array<{ text: string; type: 'info' | 'error' }> = []
let onChange: (force: boolean) => void = () => {}

function flushPendingEntries(): void {
	const tab = currentTab()
	if (!tab || pendingEntries.length === 0) return
	for (const entry of pendingEntries) tab.history.push({ type: entry.type, text: entry.text, ts: Date.now() })
	pendingEntries = []
	touchTab(tab)
}
function makeTab(id: string, name: string, opts?: { cwd?: string; model?: string }): Tab {
	return {
		sessionId: id,
		name,
		history: [],
		inputHistory: [],
		inputDraft: '',
		loaded: true,
		doneUnseen: false,
		historyVersion: 0,
		usage: { input: 0, output: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: opts?.cwd ?? '',
		model: opts?.model ?? '',
	}
}

// ── Functions ────────────────────────────────────────────────────────────────

function setOnChange(fn: (force: boolean) => void): void {
	onChange = fn
}

function currentTab(): Tab | null {
	return state.tabs[state.activeTab] ?? null
}

function touchTab(tab: Tab): void {
	tab.historyVersion++
}

function tabForSession(sessionId: string | null): Tab | null {
	if (sessionId) return state.tabs.find((tab) => tab.sessionId === sessionId) ?? null
	return currentTab()
}

function lastHistoryBlock(tab: Tab): Block | null {
	return tab.history[tab.history.length - 1] ?? null
}

function closeStreamingBlock(tab: Tab): void {
	const last = lastHistoryBlock(tab)
	if (!last) return
	if ((last.type === 'assistant' || last.type === 'thinking') && last.streaming) {
		delete last.streaming
		touchTab(tab)
	}
}

function isBusy(): boolean {
	const tab = currentTab()
	return tab ? (state.busy.get(tab.sessionId) ?? false) : false
}

function getActivity(): string {
	const tab = currentTab()
	return tab ? (state.activity.get(tab.sessionId) ?? '') : ''
}

// onTabSwitch callback — called when active tab changes, with the outgoing
// session ID. The CLI uses this to save the outgoing draft and restore the
// incoming tab's draft/history.
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
	touchTab(tab)
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
// If sessionId is given, saves to that tab (used on tab switch to save
// outgoing draft after activeTab already changed).
function saveDraft(text: string, sessionId?: string): void {
	const sid = sessionId ?? currentTab()?.sessionId
	if (!sid) return
	const tab = sessionId
		? state.tabs.find(t => t.sessionId === sessionId)
		: currentTab()
	if (tab) tab.inputDraft = text
	draftModule.saveDraft(sid, text)
}

function clearDraft(sessionId?: string): void {
	const sid = sessionId ?? currentTab()?.sessionId
	if (!sid) return
	const tab = state.tabs.find(t => t.sessionId === sid)
	if (tab) tab.inputDraft = ''
	draftModule.clearDraft(sid)
}

function onSubmit(text: string): void {
	appendInputHistory(text)
	clearDraft()
}

// ── Tab switching helpers ────────────────────────────────────────────────────

function nextTab(): void {
	if (state.tabs.length > 0) switchTab((state.activeTab + 1) % state.tabs.length)
}

function prevTab(): void {
	if (state.tabs.length > 0) switchTab((state.activeTab - 1 + state.tabs.length) % state.tabs.length)
}

// ── Prompt mirroring ─────────────────────────────────────────────────────────

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

// ── Commands ─────────────────────────────────────────────────────────────────

// Track pending open/fork so we know to copy draft on fork
let pendingOpen: 'open' | 'fork' | false = false

function sendCommand(type: string, text?: string): void {
	const tab = currentTab()
	if (type === 'open') pendingOpen = text?.startsWith('fork:') ? 'fork' : 'open'
	ipc.appendCommand({ type, text, sessionId: tab?.sessionId })
}

function hasTrailingAssistantText(tab: Tab, text: string): boolean {
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]!
		if (block.type === 'tool') continue
		return block.type === 'assistant' && block.text === text
	}
	return false
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
				// Update cwd/model from server (may have changed via /cd or /model)
				if (s.cwd) existing.cwd = s.cwd
				if (s.model) existing.model = s.model
				newTabs.push(existing)
			} else {
				newTabs.push(makeTab(s.id, s.name, { cwd: s.cwd, model: s.model }))
			}
		}
		const grew = newTabs.length > state.tabs.length
		const prevSession = state.tabs[state.activeTab]?.sessionId ?? ''
		state.tabs = newTabs
		flushPendingEntries()
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
			source: typeof event.source === 'string' ? event.source : undefined,
			status: event.label,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'stream-start' && event.sessionId) {
		const tab = tabForSession(event.sessionId)
		if (tab) closeStreamingBlock(tab)
	} else if (event.type === 'stream-delta' && event.sessionId && event.text) {
		const tab = tabForSession(event.sessionId)
		if (tab) {
			const ts = event.createdAt ? Date.parse(event.createdAt) : undefined
			const last = lastHistoryBlock(tab)
			if (event.channel === 'thinking') {
				if (last?.type === 'thinking' && last.streaming) {
					last.text += event.text
					if (event.blobId) last.blobId = event.blobId
					if (!last.sessionId) last.sessionId = event.sessionId
					if (!last.ts) last.ts = ts
				} else {
					closeStreamingBlock(tab)
					tab.history.push({
						type: 'thinking',
						text: event.text,
						blobId: event.blobId,
						sessionId: event.sessionId,
						ts,
						streaming: true,
					})
				}
			} else if (last?.type === 'assistant' && last.streaming) {
				last.text += event.text
				if (!last.ts) last.ts = ts
			} else {
				closeStreamingBlock(tab)
				tab.history.push({
					type: 'assistant',
					text: event.text,
					model: tab.model,
					ts,
					streaming: true,
				})
			}
			touchTab(tab)
			onChange(false)
		}
	} else if (event.type === 'stream-end' && event.sessionId) {
		const tab = tabForSession(event.sessionId)
		if (tab) {
			closeStreamingBlock(tab)
			if (event.usage) {
				tab.usage ??= { input: 0, output: 0 }
				tab.usage.input += event.usage.input ?? 0
				tab.usage.output += event.usage.output ?? 0
			}
			if (event.contextUsed != null) tab.contextUsed = event.contextUsed
			if (event.contextMax != null) tab.contextMax = event.contextMax
			onChange(false)
		}
	} else if (event.type === 'response') {
		const tab = tabForSession(event.sessionId ?? null)
		if (tab) closeStreamingBlock(tab)
		if (event.isError) {
			addBlockToTab(event.sessionId ?? null, {
				type: 'error',
				text: event.text,
				ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
			})
		} else if (tab && event.text && !hasTrailingAssistantText(tab, event.text)) {
			addBlockToTab(event.sessionId ?? null, {
				type: 'assistant',
				text: event.text,
				ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
			})
		}
	} else if (event.type === 'info') {
		// Keep info-level errors as error blocks in memory.
		// Persisted sessions already do this when replaying history, so live tabs
		// should match what a reload would show.
		addBlockToTab(event.sessionId ?? null, {
			type: event.level === 'error' ? 'error' : 'info',
			text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'status' && event.sessionId) {
		const wasBusy = state.busy.get(event.sessionId) ?? false
		const nowBusy = event.busy ?? false
		state.busy.set(event.sessionId, nowBusy)
		state.activity.set(event.sessionId, event.activity ?? '')
		if (wasBusy && !nowBusy) {
			const activeSession = currentTab()?.sessionId
			if (event.sessionId !== activeSession) {
				const tab = state.tabs.find(t => t.sessionId === event.sessionId)
				if (tab) tab.doneUnseen = true
			}
		}
		onChange(false)
	} else if (event.type === 'tool-call' && event.sessionId) {
		const tab = tabForSession(event.sessionId)
		if (tab) closeStreamingBlock(tab)
		addBlockToTab(event.sessionId, {
			type: 'tool',
			name: event.name,
			input: event.input,
			blobId: event.blobId,
			sessionId: event.sessionId,
			toolId: event.toolId,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'tool-result' && event.sessionId) {
		const tab = state.tabs.find((t) => t.sessionId === event.sessionId)
		if (tab) {
			const toolBlock = tab.history.find((b: any) => b.type === 'tool' && b.toolId === event.toolId) as any
			if (toolBlock) {
				toolBlock.output = event.output
				if (event.blobId) toolBlock.blobId = event.blobId
				touchTab(tab)
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
		const tab = makeTab(s.meta.id, name, { cwd: s.meta.workingDir, model: s.meta.model })
		tab.rawHistory = s.history
		tab.loaded = false
		// Sum up usage from history entries (each assistant turn has a .usage field)
		for (const entry of s.history) {
			if (entry.usage) {
				tab.usage.input += (entry.usage as any).input ?? 0
				tab.usage.output += (entry.usage as any).output ?? 0
			}
		}
		// Restore persisted context window usage so the status line shows it immediately
		if (s.meta.context) {
			tab.contextUsed = s.meta.context.used
			tab.contextMax = s.meta.context.max
		}
		newTabs.push(tab)
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
		const t0 = performance.now()
		ensureTabLoaded(active)
		const replayMs = (performance.now() - t0).toFixed(1)
		perf.mark(`Active tab replayed (${active.history.length} blocks, ${replayMs}ms)`)
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
			const t0 = performance.now()
			const n = await blockModule.loadBlobs(active.history)
			const blobMs = (performance.now() - t0).toFixed(1)
			perf.mark(`Active tab blobs loaded (${n} blobs, ${blobMs}ms)`)
			if (n > 0) touchTab(active)
			if (n > 0 && config.repaintAfterBlobLoad) onChange(false)
		}
	}

	if (!config.backgroundLoadTabs) return

	// Remaining tabs: convert history then load blobs
	const t1 = performance.now()
	let tabCount = 0
	for (const tab of state.tabs) {
		if (!tab.loaded) {
			ensureTabLoaded(tab)
			tabCount++
		}
		if (config.backgroundLoadBlobs) {
			const n = await blockModule.loadBlobs(tab.history)
			if (n > 0) touchTab(tab)
			if (n > 0 && tab === state.tabs[state.activeTab]) onChange(false)
		}
	}
	const bgMs = (performance.now() - t1).toFixed(1)
	perf.mark(`All tabs loaded (${tabCount} replayed, ${bgMs}ms)`)
}

let hostLockState: { pid: number | null; createdAt: string } | null = null

function syncHostPid(): void {
	state.hostPid = hostLockState?.pid ?? null
}

function startWatchingHostLock(): void {
	if (hostLockState) return
	// Keep a live view of host.lock in memory so the status line can show both
	// our own PID and the PID the cluster currently considers host.
	hostLockState = liveFiles.liveFile(`${STATE_DIR}/ipc/host.lock`, { pid: null, createdAt: '' })
	syncHostPid()
	liveFiles.onChange(hostLockState, () => {
		syncHostPid()
		onChange(false)
	})
}

function startClient(signal: AbortSignal): void {
	startWatchingHostLock()

	// Load persisted sessions directly from disk (fast, no IPC roundtrip).
	loadPersistedSessions()

	// Read a point-in-time snapshot and remember exactly where it ended.
	// We then tail from that byte offset so any events appended after the
	// snapshot read are still delivered. This closes the startup race where a
	// client could briefly load stale tabs and then miss the correcting
	// sessions event forever.
	const snapshot = ipc.readEventSnapshot()
	for (const event of eventsForCurrentRuntime(snapshot.events)) {
		handleEvent(event)
	}
	onChange(false)

	// Background-load blobs + remaining tabs after first paint
	void loadInBackground()

	void (async () => {
		for await (const event of ipc.tailEventsFrom(snapshot.endOffset, signal)) {
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
	handleEvent,
	onSubmit,
}

function addBlockToTab(sessionId: string | null, block: Block): void {
	const tab = tabForSession(sessionId)
	if (!tab) return
	tab.history.push(block)
	touchTab(tab)
	onChange(false)
}

function addEntry(text: string, type: 'info' | 'error' = 'info'): void {
	const tab = currentTab()
	if (!tab) {
		pendingEntries.push({ text, type })
		return
	}
	tab.history.push({ type, text, ts: Date.now() })
	touchTab(tab)
	onChange(false)
}
