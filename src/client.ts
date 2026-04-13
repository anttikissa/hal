// Client -- state manager for tabs, entries, prompt.
// Display-agnostic: a terminal CLI or web UI can drive this.

import { readFileSync, writeFileSync } from 'fs'
import { ipc } from './ipc.ts'
import type { SharedSessionInfo, SharedState } from './ipc.ts'
import { sessions as sessionStore } from './server/sessions.ts'
import { replay } from './session/replay.ts'
import { draft as draftModule } from './cli/draft.ts'
import { perf } from './perf.ts'
import { STATE_DIR } from './state.ts'
import { ason } from './utils/ason.ts'
import { liveFiles } from './utils/live-file.ts'
import { openaiUsage } from './openai-usage.ts'

// ── Types ────────────────────────────────────────────────────────────────────

import { blocks as blockModule } from './cli/blocks.ts'
import type { Block } from './cli/blocks.ts'
import type { HistoryEntry, SessionMeta } from './server/sessions.ts'
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
	// How many rawHistory entries came from a fork parent (used to dim those blocks)
	parentEntryCount: number
	liveHistory?: Block[]
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
	// Parent session ID if this tab was forked
	forkedFrom?: string
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

let pendingEntries: Array<{ text: string; type: 'info' | 'warning' | 'error' }> = []
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
		parentEntryCount: 0,
		liveHistory: [],
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

function requestRender(force = false): void { onChange(force) }

function currentTab(): Tab | null {
	return state.tabs[state.activeTab] ?? null
}

function touchTab(tab: Tab): void {
	tab.historyVersion++
}

function historyWithLive(blocks: Block[], tab: Tab): Block[] {
	const live = tab.liveHistory ?? []
	if (live.length === 0) return blocks
	return [...blocks, ...live]
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
		loadTabBlobs(tab)
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
	tab.history = historyWithLive(blockModule.historyToBlocks(tab.rawHistory!, tab.sessionId, tab.parentEntryCount, tab.forkedFrom), tab)
	tab.rawHistory = undefined
	tab.loaded = true
	touchTab(tab)
}

function loadTabBlobs(tab: Tab): void {
	if (!config.backgroundLoadBlobs) return
	void (async () => {
		const n = await blockModule.loadBlobs(tab.history)
		if (n <= 0) return
		touchTab(tab)
		if (tab === state.tabs[state.activeTab] && config.repaintAfterBlobLoad) onChange(false)
	})()
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
	openaiUsage.noteActivity()
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
	return trailingAssistantText(tab) === text
}


function assistantChainId(block: Block): string | null {
	if (block.type !== 'assistant') return null
	return block.continue ?? block.id ?? null
}

function lastInterruptedAssistantId(tab: Tab): string | null {
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]!
		if (block.type === 'tool') continue
		if (block.type === 'info' || block.type === 'warning' || block.type === 'error') continue
		return block.type === 'assistant' ? assistantChainId(block) : null
	}
	return null
}

function trailingAssistantText(tab: Tab): string | null {
	const parts: string[] = []
	let chainId: string | null = null
	let sawAssistant = false
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]!
		if (block.type === 'tool') continue
		if (block.type === 'info' || block.type === 'warning' || block.type === 'error') {
			if (!sawAssistant) continue
			continue
		}
		if (block.type !== 'assistant') break
		const blockChainId = assistantChainId(block)
		if (!sawAssistant) {
			sawAssistant = true
			chainId = blockChainId
			parts.unshift(block.text)
			continue
		}
		if (chainId && blockChainId === chainId) {
			parts.unshift(block.text)
			continue
		}
		break
	}
	return sawAssistant ? parts.join('') : null
}

function makeTabFromDisk(info: SharedSessionInfo): Tab {
	const meta = sessionStore.loadSessionMeta(info.id)
	// Load history including fork parent entries so forked tabs show full context
	const { entries: history, parentCount, parentId } = sessionStore.loadAllHistoryWithOrigin(info.id)
	const dirName = (meta?.workingDir ?? info.cwd)?.split('/').pop()
	const tab = makeTab(
		info.id,
		meta?.topic ?? info.name ?? dirName ?? `tab ${state.tabs.length + 1}`,
		{ cwd: info.cwd || meta?.workingDir, model: info.model || meta?.model },
	)
	tab.rawHistory = history
	tab.parentEntryCount = parentCount
	tab.loaded = false
	tab.liveHistory = sessionStore.loadLive(info.id).blocks as Block[]
	for (const entry of history) {
		if (entry.type !== 'assistant' || !entry.usage) continue
		tab.usage.input += entry.usage.input ?? 0
		tab.usage.output += entry.usage.output ?? 0
	}
	if (meta?.context) {
		tab.contextUsed = meta.context.used
		tab.contextMax = meta.context.max
	}
	tab.forkedFrom = meta?.forkedFrom ?? parentId
	return tab
}

function applySessionList(items: SharedSessionInfo[]): void {
	const newTabs: Tab[] = []
	const isFork = pendingOpen === 'fork'
	for (const s of items) {
		const existing = state.tabs.find((t) => t.sessionId === s.id)
		if (existing) {
			existing.name = s.name
			existing.cwd = s.cwd || existing.cwd
			existing.model = s.model || existing.model
			newTabs.push(existing)
		} else {
			newTabs.push(makeTabFromDisk(s))
		}
	}
	const grew = newTabs.length > state.tabs.length
	const prevSession = state.tabs[state.activeTab]?.sessionId ?? ''
	state.tabs = newTabs
	if (state.activeTab >= state.tabs.length) state.activeTab = state.tabs.length - 1
	if (grew) state.activeTab = state.tabs.length - 1
	const newSession = state.tabs[state.activeTab]?.sessionId ?? ''
	const active = state.tabs[state.activeTab]
	if (active && !active.loaded) ensureTabLoaded(active)
	if (active) loadTabBlobs(active)
	flushPendingEntries()
	if (isFork && grew && prevSession) {
		const prevTab = newTabs.find(t => t.sessionId === prevSession)
		const newTab = newTabs[state.activeTab]
		if (prevTab?.inputDraft && newTab) newTab.inputDraft = prevTab.inputDraft
	}
	pendingOpen = false
	if (prevSession !== newSession && onTabSwitch) onTabSwitch(prevSession, newSession)
	onChange(false)
}

function applySharedState(shared: SharedState): void {
	if (shared.openSessions.length > 0) {
		applySessionList(shared.openSessions)
	}

	const activeSession = currentTab()?.sessionId
	const nextBusy = new Map<string, boolean>()
	for (const [sessionId, busy] of Object.entries(shared.busy)) {
		if (busy) nextBusy.set(sessionId, true)
	}
	for (const [sessionId, wasBusy] of state.busy) {
		if (!wasBusy || nextBusy.get(sessionId)) continue
		if (sessionId !== activeSession) {
			const tab = state.tabs.find((item) => item.sessionId === sessionId)
			if (tab) tab.doneUnseen = true
		}
	}
	state.busy = nextBusy
	state.activity = new Map(Object.entries(shared.activity))
}

function handleEvent(event: any): void {
	if (event.type === 'runtime-start' || event.type === 'host-released' || event.type === 'sessions' || event.type === 'status') return

	if (event.type === 'prompt') {
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
				const continueId = lastInterruptedAssistantId(tab)
				tab.history.push({
					type: 'assistant',
					text: event.text,
					model: tab.model,
					id: continueId ? undefined : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
					continue: continueId ?? undefined,
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
		// Close any open streaming block first so later deltas become a visible
		// continuation chunk instead of mutating text above this notice.
		const tab = tabForSession(event.sessionId ?? null)
		if (tab) closeStreamingBlock(tab)
		// Keep info-level errors as error blocks in memory.
		// Persisted sessions already do this when replaying history, so live tabs
		// should match what a reload would show.
		addBlockToTab(event.sessionId ?? null, {
			type: event.level === 'error' ? 'error' : 'info',
			text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
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


function sessionInfoFromMeta(meta: SessionMeta, index: number): SharedSessionInfo {
	const dirName = meta.workingDir?.split('/').pop()
	return {
		id: meta.id,
		name: meta.topic ?? dirName ?? `tab ${index + 1}`,
		cwd: meta.workingDir ?? '',
		model: meta.model,
	}
}

function restoreStartupSelection(): void {
	const saved = loadClientState()
	const lastIdx = saved.lastTab ? state.tabs.findIndex((t) => t.sessionId === saved.lastTab) : -1
	state.activeTab = lastIdx >= 0 ? lastIdx : 0
	if (saved.model) state.model = saved.model

	const active = state.tabs[state.activeTab]
	if (active) {
		const t0 = performance.now()
		ensureTabLoaded(active)
		const replayMs = (performance.now() - t0).toFixed(1)
		perf.mark(`Active tab replayed (${active.history.length} blocks, ${replayMs}ms)`)
		active.inputDraft = draftModule.loadDraft(active.sessionId)
	}

	const cols = process.stdout.columns || 80
	if (saved.peakCols === cols && saved.peak > 0) state.peak = saved.peak
	state.peakCols = cols
}

function bootstrapSessions(): void {
	const items = ipcStateFile?.openSessions?.length
		? ipcStateFile.openSessions
		: sessionStore.loadAllSessionMetas().map(sessionInfoFromMeta)
	if (items.length === 0) return
	applySessionList(items)
	restoreStartupSelection()
	perf.mark(`Client loaded ${items.length} sessions (1 active)`)
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

let ipcStateFile: SharedState | null = null

function startWatchingIpcState(): void {
	if (ipcStateFile) return
	// Bootstrap state belongs in state.ason. New clients read it once, then keep
	// following changes via the file watcher while tailing only future events.
	ipcStateFile = liveFiles.liveFile(`${STATE_DIR}/ipc/state.ason`, ipc.readState())
	applySharedState(ipcStateFile)
	liveFiles.onChange(ipcStateFile, () => {
		applySharedState(ipcStateFile!)
		onChange(false)
	})
}

function resetForTests(): void {
	pendingEntries = []
	onChange = () => {}
	onTabSwitch = null
	onDraftArrived = null
	pendingOpen = false
	hostLockState = null
	ipcStateFile = null
}

function startClient(signal: AbortSignal): void {
	startWatchingHostLock()
	startWatchingIpcState()
	openaiUsage.onChange(() => onChange(false))

	void (async () => {
		for await (const event of ipc.tailEvents(signal)) {
			handleEvent(event)
		}
	})()

	// Bootstrap tabs once, using the same tab builder as normal session updates.
	bootstrapSessions()
	onChange(false)

	// Background-load blobs + remaining tabs after first paint
	void loadInBackground()
}

// ── Namespace ────────────────────────────────────────────────────────────────

export const client = {
	config,
	state,
	setOnChange,
	requestRender,
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
	resetForTests,
}

function addBlockToTab(sessionId: string | null, block: Block): void {
	const tab = tabForSession(sessionId)
	if (!tab) return
	tab.history.push(block)
	touchTab(tab)
	onChange(false)
}

function addEntry(text: string, type: 'info' | 'warning' | 'error' = 'info'): void {
	const tab = currentTab()
	if (!tab) {
		pendingEntries.push({ text, type })
		return
	}
	tab.history.push({ type, text, ts: Date.now() })
	touchTab(tab)
	onChange(false)
}
