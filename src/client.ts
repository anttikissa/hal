// Client -- state manager for tabs, entries, prompt.
// Display-agnostic: a terminal CLI or web UI can drive this.

import { ipc } from './ipc.ts'
import type { SharedSessionInfo, SharedState } from './ipc.ts'
import type { CommandType, TokenUsage } from './protocol.ts'
import type { VersionStatus } from './version.ts'
import { sessions as sessionStore } from './server/sessions.ts'
import { replay } from './session/replay.ts'
import { draft as draftModule } from './cli/draft.ts'
import { perf } from './perf.ts'
import { liveEventBlocks } from './live-event-blocks.ts'
import { startup } from './startup.ts'
import { startupSummary } from './client/startup-summary.ts'
import { sessionLoader } from './client/session-loader.ts'
import { clientTabs } from './client/tabs.ts'
import { clientCommands } from './client/commands.ts'
import { continuation } from './client/continuation.ts'
import type { ContinueAction } from './client/continuation.ts'
import { clientHistory } from './client/history.ts'
import { clientEvents } from './client/events.ts'
import { clientPersistence } from './client/persistence.ts'
import { backgroundLoader } from './client/background-loader.ts'
import { sessionTabs } from './client/session-tabs.ts'
import { clientProcess } from './client/process.ts'
import { pausedNotices } from './client/paused-notices.ts'

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
	usage: TokenUsage
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
	// Ephemeral UI-only marker shown when a loaded session has been idle >24h.
	lastActiveTs?: number
}


// ── Internal state ───────────────────────────────────────────────────────────

const config = {
	backgroundLoadTabs: true,
	backgroundLoadBlobs: true,
	repaintAfterBlobLoad: true,
	pausedNoticeDelayMs: 50,
	// Startup performance details are developer diagnostics. Keep the default
	// startup card human-focused and enable these only when debugging startup.
	showStartupPerf: false,
	claudeCacheWarningEnabled: true,
	// Derived from the observed 2026-05-01 Opus incident: ~170k cache-write
	// tokens moved the 5h subscription meter by about 24%.
	claudeCacheWarningTokensPerFiveHourPercent: 7_100,
	claudeCacheWarningQuotaPercent: 10,
	claudeCacheWarningStaleMs: 5 * 60 * 1000,
}


const state = {
	tabs: [] as Tab[],
	activeTab: 0,
	role: 'server' as 'server' | 'client',
	pid: process.pid,
	hostPid: null as number | null,
	hostVersionStatus: 'idle' as VersionStatus,
	hostVersion: '',
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
	// Most-recently viewed tab order. Used as a fallback when session-list changes
	// do not close the active tab, such as cross-client closes or startup recovery.
	recentTabs: [] as string[],
	startupSummaryShown: false,
}

let pendingEntries: Block[] = []
let onChange: (force: boolean) => void = () => {}
let onToolConfirmRequest: ((event: any) => void) | null = null



function flushPendingEntries(): void {
	const tab = currentTab()
	if (!tab || pendingEntries.length === 0) return
	for (const entry of pendingEntries) tab.history.push(entry)
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
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
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

function setOnToolConfirmRequest(fn: (event: any) => void): void {
	onToolConfirmRequest = fn
}

function requestRender(force = false): void { onChange(force) }

function currentTab(): Tab | null {
	return state.tabs[state.activeTab] ?? null
}

function rememberTab(sessionId: string): void {
	state.recentTabs = state.recentTabs.filter((id) => id !== sessionId)
	state.recentTabs.push(sessionId)
}

function pruneRecentTabs(openIds: Set<string>): void {
	state.recentTabs = state.recentTabs.filter((id) => openIds.has(id))
}

export const pickActiveSessionAfterSessionListChange = clientTabs.pickActiveSessionAfterSessionListChange

function touchTab(tab: Tab): void {
	tab.historyVersion++
}

function repaintIfActive(tab: Tab): void {
	// Background-tab stream updates are invisible until the user switches tabs.
	// Skip the redraw and let tab switch render the latest history lazily.
	if (tab === currentTab()) onChange(false)
}

function queueLocalBlock(block: Block): void {
	const tab = currentTab()
	if (!tab) {
		pendingEntries.push(block)
		return
	}
	tab.history.push(block)
	touchTab(tab)
	onChange(false)
}

function addLocalBlockToTab(tab: Tab, block: Block): void {
	tab.history.push(block)
	touchTab(tab)
	if (tab === currentTab()) onChange(false)
}

function startupSummaryText(tab: Tab): string {
	return startupSummary.text(tab, {
		fallbackModel: state.model,
		role: state.role,
		pid: state.pid,
		hostPid: state.hostPid,
		showPerf: config.showStartupPerf,
	})
}

function shouldShowStartupSummary(tab: Tab): boolean {
	return !tab.history.some((block) => block.type !== 'startup')
}

function addStartupSummaryToTab(tab: Tab): void {
	if (!shouldShowStartupSummary(tab)) return
	addLocalBlockToTab(tab, { type: 'startup', text: startupSummaryText(tab), ts: Date.now() })
}

function showStartupSummary(): void {
	if (state.startupSummaryShown) return
	state.startupSummaryShown = true
	const tab = currentTab()
	if (!tab) return
	addStartupSummaryToTab(tab)
}

function showServerRestart(pid: number, startedAt?: string): void {
	queueLocalBlock({
		type: 'startup',
		text: `Server restarted (pid ${pid})`,
		ts: startedAt ? Date.parse(startedAt) : Date.now(),
	})
}


function tabForSession(sessionId: string | null): Tab | null {
	if (sessionId) return state.tabs.find((tab) => tab.sessionId === sessionId) ?? null
	return currentTab()
}

function applyLiveEventToTab(tab: Tab, event: any): { changed: boolean; toolBlock?: any } {
	return liveEventBlocks.applyEvent({
		blocks: tab.history,
		event,
		sessionId: tab.sessionId,
		defaultModel: tab.model,
		touchBlock: blockModule.touch,
		onChange: () => touchTab(tab),
	})
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
		rememberTab(tab.sessionId)
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
	tab.history = clientHistory.withLive(blockModule.historyToBlocks(tab.rawHistory!, tab.sessionId, tab.parentEntryCount, tab.forkedFrom, tab.model), tab)
	sessionLoader.addLastActiveNotice(tab)
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


function saveClientState(opts: { restart?: boolean } = {}): void {
	const tab = currentTab()
	clientPersistence.save({
		lastTab: tab?.sessionId ?? null,
		restartTab: opts.restart ? tab?.sessionId ?? null : null,
		peak: state.peak,
		peakCols: state.peakCols,
		model: state.model,
		doneUnseen: state.tabs.filter((item) => item.doneUnseen).map((item) => item.sessionId),
	})
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


// ── Commands ─────────────────────────────────────────────────────────────────

// Track pending tab actions so a sessions update can focus the reopened/new tab.
// Fork stays distinct because it also copies the draft from the parent.

function sendCommand(type: CommandType, text?: string, displayText?: string, delivery?: 'queue'): void {
	const tab = currentTab()
	if (type === 'open') sessionTabs.state.pendingOpen = text?.startsWith('fork:') ? 'fork' : 'open'
	if (type === 'resume') sessionTabs.state.pendingOpen = 'resume'
	if (type === 'prompt') sessionTabs.state.pendingOpen = clientCommands.pendingTabActionForPrompt(text ?? '')
	ipc.appendCommand(clientCommands.makeCommand(type, tab?.sessionId, text, displayText, delivery))
}


function continueActionForTab(tab: Tab | null): ContinueAction | false {
	return continuation.actionForTab(tab, tab ? (state.busy.get(tab.sessionId) ?? false) : false)
}

function continueActionForCurrentTurn(): ContinueAction | false {
	return continueActionForTab(currentTab())
}

function canContinueCurrentTurn(): boolean {
	return !!continueActionForCurrentTurn()
}


function makeTabFromDisk(info: SharedSessionInfo): Tab {
	const snapshot = sessionLoader.load(info)
	const tab = makeTab(snapshot.id, snapshot.name, { cwd: snapshot.cwd, model: snapshot.model })
	tab.rawHistory = snapshot.history
	tab.parentEntryCount = snapshot.parentEntryCount
	tab.lastActiveTs = snapshot.lastActiveTs
	tab.loaded = false
	tab.liveHistory = snapshot.liveHistory
	tab.usage = snapshot.usage
	tab.contextUsed = snapshot.contextUsed
	tab.contextMax = snapshot.contextMax
	tab.forkedFrom = snapshot.forkedFrom
	return tab
}

function applySessionList(items: SharedSessionInfo[], preferredSession = ''): void {
	sessionTabs.apply(items, preferredSession, {
		model: state,
		makeTabFromDisk,
		ensureTabLoaded,
		loadTabBlobs,
		flushPendingEntries,
		rememberTab,
		pruneRecentTabs,
		addStartupSummaryToTab,
		addTabNoticeToTab: (tab: Tab, text: string) => addLocalBlockToTab(tab, { type: 'startup', text, ts: Date.now() }),
		onTabSwitch: (from: string, to: string) => onTabSwitch?.(from, to),
		onChange,
	})
}

function applySharedStatus(shared: SharedState): void {
	const activeSession = currentTab()?.sessionId
	const nextBusy = new Map<string, boolean>()
	let changedDoneUnseen = false
	for (const [sessionId, busy] of Object.entries(shared.busy)) {
		if (busy) nextBusy.set(sessionId, true)
	}
	for (const [sessionId, wasBusy] of state.busy) {
		if (!wasBusy || nextBusy.get(sessionId)) continue
		if (sessionId !== activeSession) {
			const tab = state.tabs.find((item) => item.sessionId === sessionId)
			if (tab && !tab.doneUnseen) {
				tab.doneUnseen = true
				changedDoneUnseen = true
			}
		}
	}
	state.busy = nextBusy
	state.activity = new Map(Object.entries(shared.activity))
	if (changedDoneUnseen) saveClientState()
	state.hostVersionStatus = shared.host?.versionStatus ?? 'idle'
	state.hostVersion = shared.host?.version ?? ''
}

function applySharedState(shared: SharedState): void {
	if (shared.sessions.length > 0) applySessionList(shared.sessions)
	applySharedStatus(shared)
}

function handleEvent(event: any): void {
	clientEvents.handle(event, {
		pid: state.pid,
		currentTab,
		tabForSession,
		addBlockToTab,
		showServerRestart,
		cancelDelayedPaused: (sessionId: string | null) => pausedNotices.cancel(sessionId),
		flushDelayedPaused: (sessionId: string | null) => pausedNotices.flush(sessionId, (block) => addBlockToTab(sessionId, block)),
		scheduleDelayedPaused: (sessionId: string | null, block: Extract<Block, { type: 'info' }>) => pausedNotices.schedule(sessionId, block, config.pausedNoticeDelayMs, (item) => addBlockToTab(sessionId, item)),
		applyLiveEventToTab,
		repaintIfActive,
		touchTab,
		onToolConfirmRequest: (item: any) => onToolConfirmRequest?.(item),
		onDraftArrived: (text: string) => onDraftArrived?.(text),
		onChange,
	})
}


function sessionInfoFromMeta(meta: SessionMeta, index: number): SharedSessionInfo {
	return {
		id: meta.id,
		tab: index + 1,
		name: meta.name,
		cwd: meta.workingDir ?? '',
		model: meta.model,
	}
}

function initializeSessions(shared: SharedState, opts: { preferredCwd?: string; preferredSessionId?: string } = {}): void {
	const items = shared.sessions.length > 0
		? shared.sessions
		: sessionStore.loadAllSessionMetas().map(sessionInfoFromMeta)
	if (items.length === 0) {
		applySharedStatus(shared)
		return
	}

	const saved = clientPersistence.load()
	const restartTab = saved.restartTab ? items.find((item) => item.id === saved.restartTab) : undefined
	const savedTab = saved.lastTab ? items.find((item) => item.id === saved.lastTab) : undefined
	const savedTabFitsRequest = savedTab && (!opts.preferredCwd || startup.sameCwd(savedTab.cwd, opts.preferredCwd))
	const cwdPreferredSession = opts.preferredSessionId
		?? (opts.preferredCwd ? startup.findOpenSessionForCwd(items, opts.preferredCwd) ?? '' : '')
	// Ctrl-R is an explicit restart of the current UI, not a fresh attach from the
	// shell cwd. If the saved restart tab still exists, it wins even when another
	// tab matches the requested cwd more closely.
	const preferredSession = restartTab
		? restartTab.id
		: savedTabFitsRequest ? saved.lastTab! : (cwdPreferredSession || saved.lastTab || '')
	const t0 = performance.now()
	applySessionList(items, preferredSession)
	const active = currentTab()
	const unseenDone = new Set(saved.doneUnseen)
	for (const tab of state.tabs) tab.doneUnseen = tab.sessionId !== active?.sessionId && unseenDone.has(tab.sessionId)
	if (saved.model) state.model = saved.model
	if (active) {
		const replayMs = (performance.now() - t0).toFixed(1)
		perf.mark(`Active tab replayed (${active.history.length} blocks, ${replayMs}ms)`)
		active.inputDraft = draftModule.loadDraft(active.sessionId)
	}

	const cols = process.stdout.columns || 80
	if (saved.peakCols === cols && saved.peak > 0) state.peak = saved.peak
	state.peakCols = cols
	applySharedStatus(shared)
	perf.mark(`Client loaded ${items.length} sessions (1 active)`)
}

async function loadInBackground(): Promise<void> {
	await backgroundLoader.load({
		config,
		tabs: state.tabs,
		activeTab: () => state.activeTab,
		ensureTabLoaded,
		touchTab,
		showStartupSummary,
		onChange,
	})
}


function resetForTests(): void {
	pendingEntries = []
	pausedNotices.reset()
	onChange = () => {}
	onTabSwitch = null
	onDraftArrived = null
	onToolConfirmRequest = null
	sessionTabs.reset()
	clientProcess.reset()
	state.recentTabs = []
	state.startupSummaryShown = true
	state.hostVersionStatus = 'idle'
	state.hostVersion = ''
}

function startClient(signal: AbortSignal, opts: { preferredCwd?: string; preferredSessionId?: string; openCwd?: string } = {}): void {
	clientProcess.start(signal, opts, {
		setHostPid: (pid: number | null) => { state.hostPid = pid },
		applySharedState,
		handleEvent,
		initializeSessions,
		currentSessionId: () => currentTab()?.sessionId,
		loadInBackground,
		onChange,
		onStartupOpen: () => { sessionTabs.state.pendingOpen = 'open' },
	})
}

// ── Namespace ────────────────────────────────────────────────────────────────

export const client = {
	config,
	state,
	setOnChange,
	requestRender,
	setOnToolConfirmRequest,
	setOnTabSwitch,
	setOnDraftArrived,
	currentTab,
	isBusy,
	getActivity,
	canContinueCurrentTurn,
	continueActionForCurrentTurn,
	switchTab,
	nextTab,
	prevTab,
	addEntry,
	addStartupEntry: (text: string) => queueLocalBlock({ type: 'startup', text, ts: Date.now() }),
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
	queueLocalBlock({ type, text, ts: Date.now() })
}

