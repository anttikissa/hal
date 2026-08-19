// Client -- state manager for tabs, entries, prompt.
// Display-agnostic: a terminal CLI or web UI can drive this.

import { clientTransport } from './transport.ts'
import type { ContinuationAction, SharedSessionInfo, SharedState } from '../common/ipc.ts'
import type { TokenUsage, VersionStatus } from '../common/protocol.ts'
import { clientBackend } from './backend.ts'
import { historyProjection } from '../common/history-projection.ts'
import { draft as draftModule, type DraftPromptEdit } from './draft.ts'
import { perf } from './perf.ts'
import { liveEventBlocks, type LiveEvent } from '../common/live-event-blocks.ts'
import { sessionLoader } from './session-loader.ts'
import { clientTabs } from './tabs.ts'
import { clientCommands, type ClientCommandType } from './commands.ts'
import { clientHistory } from './history.ts'
import { clientEvents } from './events.ts'
import { clientPersistence } from './persistence.ts'
import { backgroundLoader } from './background-loader.ts'
import { sessionTabs } from './session-tabs.ts'
import { clientProcess } from './process.ts'
import { pausedNotices } from './paused-notices.ts'

// ── Types ────────────────────────────────────────────────────────────────────

import { blockData } from './block-data.ts'
import type { Block } from './block-data.ts'
import type { HistoryEntry } from '../common/history.ts'
import type { SessionMeta } from '../common/session.ts'
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
	inputDraftEdit?: DraftPromptEdit
	// Tabs start unloaded: raw history is stashed here and converted to
	// blocks on demand (focused tab at startup, others in background).
	rawHistory?: HistoryEntry[]
	// How many rawHistory entries came from a fork parent (used to dim those blocks)
	parentEntryCount: number
	liveHistory?: Block[]
	loaded: boolean
	// Generation finished on a non-focused tab — show ✓ until user switches to it
	doneUnseen: boolean
	attention?: 'new'
	continuation?: ContinuationAction
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
	currentLog?: string
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
	claudeCacheWarningEnabled: true,
	// Derived from the observed 2026-05-01 Opus incident: ~170k cache-write
	// tokens moved the 5h subscription meter by about 24%.
	claudeCacheWarningTokensPerFiveHourPercent: 7_100,
	claudeCacheWarningQuotaPercent: 10,
	claudeCacheWarningStaleMs: 5 * 60 * 1000,
}


const state = {
	tabs: [] as Tab[],
	focusedTabIndex: 0,
	sessionLabelVersion: 0,
	role: 'server' as 'server' | 'client',
	pid: process.pid,
	startedAt: new Date().toISOString(),
	hostPid: null as number | null,
	hostVersionStatus: 'idle' as VersionStatus,
	hostVersion: '',
	localVersionStatus: 'idle' as VersionStatus,
	localVersion: '',
	localVersionError: '',
	// Persisted across restarts so the prompt stays at a stable position.
	// Invalidated if terminal width changed since last save.
	peak: 0,
	peakCols: 0,
	// Current model selection, persisted across restarts
	model: null as string | null,
	// Working state per session — true while a turn is in progress.
	working: new Map<string, boolean>(),
	// Submitted text stays locally pending until its prompt event arrives, closing
	// the command-delivery window where Up must already pause the turn.
	pendingPromptTexts: new Map<string, string>(),
	// Host-local turn control bypasses disk IPC so prompt/abort ordering is synchronous.
	localCommandHandler: null as ((command: ReturnType<typeof clientCommands.makeCommand>) => void) | null,
	// Background /what summaries. Separate from normal working state so prompts still behave as idle.
	summarizing: new Set<string>(),
	whatDoneUnseen: new Set<string>(),
	// Sessions waiting for the user to answer a risky tool confirmation popup.
	toolConfirmPending: new Set<string>(),
	// Most-recently viewed tab order. Used as a fallback when session-list changes
	// do not close the focused tab, such as cross-client closes or startup recovery.
	recentTabs: [] as string[],
	restoreTabHint: false,
}

let pendingEntries: Block[] = []
let onChange: (force: boolean) => void = () => {}
let onToolConfirmRequest: ((event: any) => void) | null = null
let onRebaseStart: ((event: any) => void) | null = null
let onRebaseResult: ((event: any) => void) | null = null



function flushPendingEntries(): void {
	const tab = currentTab()
	if (!tab || pendingEntries.length === 0) return
	for (const entry of pendingEntries) tab.history.push(entry)
	pendingEntries = []
	touchTab(tab)
}
function makeTab(id: string, name: string, opts?: { cwd?: string; model?: string; currentLog?: string }): Tab {
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
		attention: undefined,
		historyVersion: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: opts?.cwd ?? '',
		model: opts?.model ?? '',
		currentLog: opts?.currentLog ?? 'history.asonl',
	}
}

// ── Functions ────────────────────────────────────────────────────────────────

function setOnChange(fn: (force: boolean) => void): void {
	onChange = fn
}

function setOnToolConfirmRequest(fn: (event: any) => void): void {
	onToolConfirmRequest = fn
}

function setOnRebaseStart(fn: (event: any) => void): void {
	onRebaseStart = fn
}

function setOnRebaseResult(fn: (event: any) => void): void {
	onRebaseResult = fn
}

function requestRender(force = false): void { onChange(force) }

function clearRestoreTabHint(): void { state.restoreTabHint = false }

function showRestoreTabHint(): void { state.restoreTabHint = true }

function currentTab(): Tab | null {
	return state.tabs[state.focusedTabIndex] ?? null
}

function focusSession(sessionId: string | undefined): void {
	if (!sessionId) return
	clientTransport.io.appendCommand({ type: 'focus', sessionId })
}

function focusCurrentTab(): void {
	focusSession(currentTab()?.sessionId)
}

function publishStatus(): void {
	if (state.role !== 'client') return
	const tab = currentTab()
	clientTransport.io.appendCommand({
		type: 'client-status',
		sessionId: tab?.sessionId,
		pid: state.pid,
		startedAt: state.startedAt,
		updatedAt: new Date().toISOString(),
		cwd: tab?.cwd,
		versionStatus: state.localVersionStatus,
		version: state.localVersion || undefined,
		error: state.localVersionError || undefined,
	})
}

function publishExit(): void {
	if (state.role !== 'client') return
	clientTransport.io.appendCommand({ type: 'client-exit', sessionId: currentTab()?.sessionId, pid: state.pid })
}

function rememberTab(sessionId: string): void {
	state.recentTabs = state.recentTabs.filter((id) => id !== sessionId)
	state.recentTabs.push(sessionId)
}

function pruneRecentTabs(openIds: Set<string>): void {
	state.recentTabs = state.recentTabs.filter((id) => openIds.has(id))
}

export const pickFocusedSessionAfterSessionListChange = clientTabs.pickFocusedSessionAfterSessionListChange

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


function showServerRestart(pid: number, startedAt?: string): void {
	queueLocalBlock({
		type: 'info',
		text: `Server restarted (pid ${pid})`,
		ts: startedAt ? Date.parse(startedAt) : Date.now(),
	})
}

function showServerPromotion(pid: number, startedAt?: string): void {
	queueLocalBlock({
		type: 'info',
		text: `Client promoted to server (pid ${pid})`,
		ts: startedAt ? Date.parse(startedAt) : Date.now(),
	})
}


function tabForSession(sessionId: string | null): Tab | null {
	if (sessionId) return state.tabs.find((tab) => tab.sessionId === sessionId) ?? null
	return currentTab()
}

function sessionLabel(sessionId: string): string {
	const index = state.tabs.findIndex((tab) => tab.sessionId === sessionId)
	const tab = state.tabs[index]
	if (!tab) return sessionId
	const details = [tab.name === tab.sessionId ? '' : tab.name, index >= 0 ? `tab ${index + 1}` : ''].filter(Boolean).join(', ')
	return details ? `${sessionId} (${details})` : sessionId
}

function applyLiveEventToTab(tab: Tab, event: LiveEvent) {
	const result = liveEventBlocks.reduce(tab.history, event, {
		sessionId: tab.sessionId,
		defaultModel: tab.model,
	})
	if (result.changed) {
		tab.history = result.blocks
		touchTab(tab)
	}
	return result
}

function isWorking(): boolean {
	const tab = currentTab()
	if (!tab) return false
	return state.working.get(tab.sessionId) === true || state.pendingPromptTexts.has(tab.sessionId)
}

function setSummarizing(sessionId: string, active: boolean): void {
	if (active) state.summarizing.add(sessionId)
	else state.summarizing.delete(sessionId)
	onChange(false)
}

function markWhatDone(sessionId: string): void {
	if (currentTab()?.sessionId !== sessionId) state.whatDoneUnseen.add(sessionId)
	onChange(false)
}


function markToolConfirmPending(sessionId: string): void {
	state.toolConfirmPending.add(sessionId)
}

function clearToolConfirmPending(sessionId: string): void {
	state.toolConfirmPending.delete(sessionId)
}

// onTabSwitch callback — called when focused tab changes, with the outgoing
// session ID. The CLI uses this to save the outgoing draft and restore the
// incoming tab's draft/history.
let onTabSwitch: ((fromSession: string, toSession: string) => void) | null = null

function setOnTabSwitch(fn: (from: string, to: string) => void): void {
	onTabSwitch = fn
}

// onDraftArrived callback — fired when another client saves a draft for
// the focused tab and our prompt is empty. The CLI uses this to show the
// draft text (e.g. client A quits with a draft, client B picks it up).
let onDraftArrived: ((text: string, promptEdit?: DraftPromptEdit) => void) | null = null

function setOnDraftArrived(fn: (text: string, promptEdit?: DraftPromptEdit) => void): void {
	onDraftArrived = fn
}

function switchTab(index: number): void {
	if (index >= 0 && index < state.tabs.length && index !== state.focusedTabIndex) {
		clearRestoreTabHint()
		const fromSession = state.tabs[state.focusedTabIndex]?.sessionId ?? ''
		state.focusedTabIndex = index
		const tab = state.tabs[index]!
		// Clear "done unseen" flag — user is now looking at this tab
		tab.doneUnseen = false
		state.whatDoneUnseen.delete(tab.sessionId)
		tab.attention = undefined
		ensureTabLoaded(tab)
		loadTabBlobs(tab)
		rememberTab(tab.sessionId)
		focusSession(tab.sessionId)
		// Re-read draft from disk — another client may have saved one
		const diskDraft = draftModule.loadDraftState(tab.sessionId)
		if ((diskDraft.text || diskDraft.promptEdit) && !tab.inputDraft) {
			tab.inputDraft = diskDraft.text
			tab.inputDraftEdit = diskDraft.promptEdit
		}
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
	tab.inputHistory = historyProjection.inputHistoryFromEntries(tab.rawHistory!)
	tab.history = clientHistory.withLive(blockData.historyToBlocks(tab.rawHistory!, tab.sessionId, tab.parentEntryCount, tab.forkedFrom, tab.model), tab)
	sessionLoader.addLastActiveNotice(tab)
	tab.rawHistory = undefined
	tab.loaded = true
	touchTab(tab)
}

function reloadTabFromDisk(tab: Tab, opts: { logName?: string; entryLimit?: number } = {}): void {
	const snapshot = sessionLoader.load({ id: tab.sessionId, name: tab.name, cwd: tab.cwd, model: tab.model }, opts)
	tab.rawHistory = snapshot.history
	tab.parentEntryCount = snapshot.parentEntryCount
	tab.lastActiveTs = snapshot.lastActiveTs
	tab.liveHistory = snapshot.liveHistory
	tab.usage = snapshot.usage
	tab.contextUsed = snapshot.contextUsed
	tab.contextMax = snapshot.contextMax
	tab.forkedFrom = snapshot.forkedFrom
	tab.loaded = false
	ensureTabLoaded(tab)
	loadTabBlobs(tab)
}

function loadTabBlobs(tab: Tab): void {
	if (!config.backgroundLoadBlobs) return
	void (async () => {
		const n = await blockData.loadBlobs(tab.history)
		if (n <= 0) return
		touchTab(tab)
		if (tab === state.tabs[state.focusedTabIndex] && config.repaintAfterBlobLoad) onChange(false)
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
function loadDraftIntoTab(tab: Tab): void {
	const file = draftModule.loadDraftState(tab.sessionId)
	tab.inputDraft = file.text
	tab.inputDraftEdit = file.promptEdit
}

function getInputDraft(): string {
	return currentTab()?.inputDraft ?? ''
}

// Save draft text to memory + disk + IPC notification.
// If sessionId is given, saves to that tab (used on tab switch to save
// outgoing draft after focusedTabIndex already changed).
function saveDraft(text: string, sessionId?: string, promptEdit?: DraftPromptEdit): void {
	const sid = sessionId ?? currentTab()?.sessionId
	if (!sid) return
	const tab = sessionId
		? state.tabs.find(t => t.sessionId === sessionId)
		: currentTab()
	if (tab) {
		tab.inputDraft = text
		tab.inputDraftEdit = promptEdit
	}
	draftModule.saveDraft(sid, text, promptEdit)
}

function clearDraft(sessionId?: string): void {
	const sid = sessionId ?? currentTab()?.sessionId
	if (!sid) return
	const tab = state.tabs.find(t => t.sessionId === sid)
	if (tab) {
		tab.inputDraft = ''
		tab.inputDraftEdit = undefined
	}
	draftModule.clearDraft(sid)
}

function onSubmit(text: string): void {
	appendInputHistory(text)
	clearDraft()
}

// ── Tab switching helpers ────────────────────────────────────────────────────

function nextTab(): void {
	if (state.tabs.length > 0) switchTab((state.focusedTabIndex + 1) % state.tabs.length)
}

function prevTab(): void {
	if (state.tabs.length > 0) switchTab((state.focusedTabIndex - 1 + state.tabs.length) % state.tabs.length)
}


// ── Commands ─────────────────────────────────────────────────────────────────

// Track pending tab actions so a sessions update can focus the reopened/new tab.
// Fork stays distinct because it also copies the draft from the parent.

function sendCommand(type: ClientCommandType, text?: string, displayText?: string, queue?: boolean): void {
	if (type !== 'close') clearRestoreTabHint()
	const tab = currentTab()
	if (type === 'open') sessionTabs.state.pendingOpen = text?.startsWith('fork:') ? 'fork' : 'open'
	if (type === 'resume') sessionTabs.state.pendingOpen = 'resume'
	if (type === 'prompt') sessionTabs.state.pendingOpen = clientCommands.pendingTabActionForPrompt(text ?? '')
	const command = clientCommands.makeCommand(type, tab?.sessionId, text, displayText, queue)
	const isTurnControl = type === 'prompt' || type === 'prompt-amend' || type === 'abort' || type === 'continue'
	if (isTurnControl && state.localCommandHandler) state.localCommandHandler(command)
	else clientTransport.io.appendCommand(command)
	const isPromptTurn = type === 'prompt' || type === 'prompt-amend'
	if (isPromptTurn && tab && text && !text.trimStart().startsWith('/') && (type === 'prompt-amend' || !queue || !isWorking())) {
		state.pendingPromptTexts.set(tab.sessionId, text)
	}
	// Hide the retry/continue affordance immediately; the shared working state
	// arrives on the next IPC update, but this client already queued the turn.
	if (type === 'continue' && tab) state.working.set(tab.sessionId, true)
}


function continueActionForTab(tab: Tab | null): ContinuationAction | false {
	if (!tab || state.working.get(tab.sessionId)) return false
	return tab.continuation ?? false
}

function continueActionForCurrentTurn(): ContinuationAction | false {
	return continueActionForTab(currentTab())
}

function canContinueCurrentTurn(): boolean {
	return !!continueActionForCurrentTurn()
}


function makeTabFromDisk(info: SharedSessionInfo): Tab {
	const snapshot = sessionLoader.load(info)
	const tab = makeTab(snapshot.id, snapshot.name, { cwd: snapshot.cwd, model: snapshot.model, currentLog: snapshot.currentLog })
	tab.continuation = info.continuation
	tab.rawHistory = snapshot.history
	tab.parentEntryCount = snapshot.parentEntryCount
	tab.lastActiveTs = snapshot.lastActiveTs
	tab.loaded = false
	tab.liveHistory = snapshot.liveHistory
	tab.usage = snapshot.usage
	tab.contextUsed = snapshot.contextUsed
	tab.contextMax = snapshot.contextMax
	tab.forkedFrom = snapshot.forkedFrom
	tab.attention = info.attention
	loadDraftIntoTab(tab)
	return tab
}

function applySessionList(items: SharedSessionInfo[], preferredSession = ''): void {
	const previousLabels = state.tabs.map((tab) => `${tab.sessionId}\0${tab.name}`).join('\n')
	sessionTabs.apply(items, preferredSession, {
		model: state,
		makeTabFromDisk,
		ensureTabLoaded,
		loadTabBlobs,
		flushPendingEntries,
		rememberTab,
		pruneRecentTabs,
		addTabNoticeToTab: (tab: Tab, text: string) => addLocalBlockToTab(tab, { type: 'info', text, ts: Date.now() }),
		showRestoreTabHint,
		clearRestoreTabHint,
		onTabSwitch: (from: string, to: string) => onTabSwitch?.(from, to),
		onChange,
	})
	if (previousLabels !== state.tabs.map((tab) => `${tab.sessionId}\0${tab.name}`).join('\n')) state.sessionLabelVersion++
}

function applySharedStatus(shared: SharedState): void {
	const activeSession = currentTab()?.sessionId
	const nextWorking = new Map<string, boolean>()
	let changedDoneUnseen = false
	for (const [sessionId, working] of Object.entries(shared.working)) {
		if (working) nextWorking.set(sessionId, true)
	}
	for (const [sessionId, wasWorking] of state.working) {
		if (!wasWorking || nextWorking.get(sessionId)) continue
		if (sessionId !== activeSession) {
			const tab = state.tabs.find((item) => item.sessionId === sessionId)
			if (tab && !tab.doneUnseen) {
				tab.doneUnseen = true
				changedDoneUnseen = true
			}
		}
	}
	state.working = nextWorking
	state.summarizing = new Set(Object.keys(shared.summarizing ?? {}))
	for (const sessionId of state.toolConfirmPending) {
		if (!nextWorking.get(sessionId)) state.toolConfirmPending.delete(sessionId)
	}
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
		clearPendingPrompt: (sessionId: string, text?: string) => {
			if (text === undefined || state.pendingPromptTexts.get(sessionId) === text) state.pendingPromptTexts.delete(sessionId)
		},
		currentTab,
		tabForSession,
		sessionLabel,
		addBlockToTab,
		showServerRestart,
		showServerPromotion,
		cancelDelayedPaused: (sessionId: string | null) => pausedNotices.cancel(sessionId),
		flushDelayedPaused: (sessionId: string | null) => pausedNotices.flush(sessionId, (block) => addBlockToTab(sessionId, block)),
		scheduleDelayedPaused: (sessionId: string | null, block: Extract<Block, { type: 'log' }>) => pausedNotices.schedule(sessionId, block, config.pausedNoticeDelayMs, (item) => addBlockToTab(sessionId, item)),
		applyLiveEventToTab,
		repaintIfActive,
		touchTab,
		reloadTabFromDisk,
		onToolConfirmRequest: (item: any) => onToolConfirmRequest?.(item),
		markToolConfirmPending,
		clearToolConfirmPending,
		setSummarizing,
		markWhatDone,
		onDraftArrived: (text: string, promptEdit?: DraftPromptEdit) => onDraftArrived?.(text, promptEdit),
		onRebaseStart: (item: any) => onRebaseStart?.(item),
		onRebaseResult: (item: any) => onRebaseResult?.(item),
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
		currentLog: meta.currentLog ?? 'history.asonl',
	}
}

function initializeSessions(shared: SharedState, opts: { preferredSessionId?: string; viewportCols?: number } = {}): void {
	const items = shared.sessions.length > 0
		? shared.sessions
		: clientBackend.sessions.loadAllSessionMetas().map(sessionInfoFromMeta)
	if (items.length === 0) {
		applySharedStatus(shared)
		return
	}

	const saved = clientPersistence.load()
	const restartTab = saved.restartTab ? items.find((item) => item.id === saved.restartTab) : undefined
	// Ctrl-R restarts this UI and therefore preserves its current tab. A fresh peer
	// invocation supplies a preferred session explicitly; only then do we override
	// ordinary persisted focus with the session selected for the peer's cwd.
	const preferredSession = restartTab?.id ?? opts.preferredSessionId ?? saved.lastTab ?? undefined
	const t0 = performance.now()
	applySessionList(items, preferredSession)
	const focused = currentTab()
	const unseenDone = new Set(saved.doneUnseen)
	for (const tab of state.tabs) tab.doneUnseen = tab.sessionId !== focused?.sessionId && unseenDone.has(tab.sessionId)
	if (saved.model) state.model = saved.model
	if (focused) {
		const replayMs = (performance.now() - t0).toFixed(1)
		perf.mark(`Focused tab replayed (${focused.history.length} blocks, ${replayMs}ms)`)
	}

	const cols = opts.viewportCols ?? 80
	if (saved.peakCols === cols && saved.peak > 0) state.peak = saved.peak
	state.peakCols = cols
	applySharedStatus(shared)
	perf.mark(`Client loaded ${items.length} sessions (1 focused)`)
}

async function loadInBackground(): Promise<void> {
	await backgroundLoader.load({
		config,
		tabs: state.tabs,
		focusedTabIndex: () => state.focusedTabIndex,
		ensureTabLoaded,
		touchTab,
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
	onRebaseStart = null
	onRebaseResult = null
	clearRestoreTabHint()
	sessionTabs.reset()
	clientProcess.reset()
	state.recentTabs = []
	state.sessionLabelVersion = 0
	state.hostVersionStatus = 'idle'
	state.hostVersion = ''
	state.localVersionStatus = 'idle'
	state.localVersion = ''
	state.localVersionError = ''
	state.toolConfirmPending.clear()
	state.summarizing.clear()
	state.whatDoneUnseen.clear()
}

function startClient(signal: AbortSignal, opts: { preferredSessionId?: string; openCwd?: string; viewportCols?: number } = {}): void {
	clientProcess.start(signal, opts, {
		setHostPid: (pid: number | null) => { state.hostPid = pid },
		applySharedState,
		handleEvent,
		initializeSessions,
		currentSessionId: () => currentTab()?.sessionId,
		focusCurrentTab,
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
	setOnRebaseStart,
	setOnRebaseResult,
	setOnTabSwitch,
	setOnDraftArrived,
	currentTab,
	sessionLabel,
	isWorking,
	markToolConfirmPending,
	clearToolConfirmPending,
	canContinueCurrentTurn,
	continueActionForCurrentTurn,
	continueActionForTab,
	switchTab,
	nextTab,
	prevTab,
	addEntry,
	addStartupEntry: (text: string) => queueLocalBlock({ type: 'info', text, ts: Date.now() }),
	sendCommand,
	publishStatus,
	publishExit,
	startClient,
	saveState: saveClientState,
	getInputHistory,
	appendInputHistory,
	getInputDraft,
	saveDraft,
	clearDraft,
	handleEvent,
	onSubmit,
	showRestoreTabHint,
	clearRestoreTabHint,
	resetForTests,
}

function addBlockToTab(sessionId: string | null, block: Block): void {
	const tab = tabForSession(sessionId)
	if (!tab) return
	tab.history.push(block)
	touchTab(tab)
	onChange(false)
}

function addEntry(text: string, type: 'log' | 'info' | 'warning' | 'error' = 'log'): void {
	queueLocalBlock({ type, text, ts: Date.now() })
}

