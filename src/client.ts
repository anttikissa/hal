// Client -- state manager for tabs, entries, prompt.
// Display-agnostic: a terminal CLI or web UI can drive this.

import { readFileSync, writeFileSync } from 'fs'
import { ipc } from './ipc.ts'
import type { SharedSessionInfo, SharedState } from './ipc.ts'
import type { Command, CommandType, TokenUsage } from './protocol.ts'
import type { VersionStatus } from './version.ts'
import { sessions as sessionStore } from './server/sessions.ts'
import { replay } from './session/replay.ts'
import { draft as draftModule } from './cli/draft.ts'
import { perf } from './perf.ts'
import { STATE_DIR } from './state.ts'
import { ason } from './utils/ason.ts'
import { liveFiles } from './utils/live-file.ts'
import { openaiUsage } from './openai-usage.ts'
import { liveEventBlocks } from './live-event-blocks.ts'
import { log } from './utils/log.ts'

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
}

// ── Internal state ───────────────────────────────────────────────────────────

const config = {
	backgroundLoadTabs: true,
	backgroundLoadBlobs: true,
	repaintAfterBlobLoad: true,
	pausedNoticeDelayMs: 50,
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
	// Most-recently viewed tab order. Used to choose where focus returns after
	// closing a tab, matching browser behavior better than "always pick left/right".
	recentTabs: [] as string[],
	startupSummaryShown: false,
}

let pendingEntries: Block[] = []
let onChange: (force: boolean) => void = () => {}


type DelayedPausedNotice = {
	timer: ReturnType<typeof setTimeout>
	block: Extract<Block, { type: 'info' }>
}

let delayedPausedNotices = new Map<string, DelayedPausedNotice>()

function delayedPausedKey(sessionId: string | null): string {
	return sessionId ?? ''
}

function cancelDelayedPaused(sessionId: string | null): void {
	const key = delayedPausedKey(sessionId)
	const pending = delayedPausedNotices.get(key)
	if (!pending) return
	clearTimeout(pending.timer)
	delayedPausedNotices.delete(key)
}

function flushDelayedPaused(sessionId: string | null): void {
	const key = delayedPausedKey(sessionId)
	const pending = delayedPausedNotices.get(key)
	if (!pending) return
	clearTimeout(pending.timer)
	delayedPausedNotices.delete(key)
	addBlockToTab(sessionId, pending.block)
}

function scheduleDelayedPaused(sessionId: string | null, block: Extract<Block, { type: 'info' }>): void {
	cancelDelayedPaused(sessionId)
	if (config.pausedNoticeDelayMs <= 0) {
		addBlockToTab(sessionId, block)
		return
	}
	const key = delayedPausedKey(sessionId)
	const timer = setTimeout(() => {
		delayedPausedNotices.delete(key)
		addBlockToTab(sessionId, block)
	}, config.pausedNoticeDelayMs)
	delayedPausedNotices.set(key, { timer, block })
}

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

export function pickActiveSessionAfterSessionListChange(opts: {
	previousSession: string
	previousIndex: number
	previousLength: number
	newSessionIds: string[]
	recentTabs: string[]
	pendingOpen: 'open' | 'fork' | 'resume' | false
	openedSessionId: string
}): string {
	const { previousSession, previousIndex, previousLength, newSessionIds, recentTabs, pendingOpen, openedSessionId } = opts
	const openIds = new Set(newSessionIds)
	const grew = newSessionIds.length > previousLength
	const shrank = newSessionIds.length < previousLength
	const activeTabClosed = previousSession !== '' && !openIds.has(previousSession)

	if (grew && pendingOpen && openedSessionId) return openedSessionId
	if (previousSession && openIds.has(previousSession)) return previousSession

	// If the active tab was closed, stay at the same numeric slot when possible.
	// Example: closing tab 24 should focus what used to be tab 25, now in slot 24.
	// Only when the closed tab was the last one do we fall back to the new last tab.
	if (shrank && activeTabClosed) {
		const sameSlot = Math.min(previousIndex, newSessionIds.length - 1)
		return newSessionIds[sameSlot] ?? ''
	}

	for (let i = recentTabs.length - 1; i >= 0; i--) {
		const sessionId = recentTabs[i]!
		if (openIds.has(sessionId)) return sessionId
	}

	const fallbackIndex = previousIndex > 0 ? Math.min(previousIndex - 1, newSessionIds.length - 1) : 0
	return newSessionIds[fallbackIndex] ?? newSessionIds[0] ?? ''
}

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

function perfMs(prefix: string): string | null {
	const hit = perf.snapshot().findLast((mark) => mark.name.startsWith(prefix))
	return hit ? `${hit.ms.toFixed(1)}ms` : null
}

function showStartupSummary(): void {
	if (state.startupSummaryShown) return
	state.startupSummaryShown = true
	const ready = perfMs('Ready for input')
	const firstLine = state.role === 'server'
		? `Server started (pid ${state.pid})${ready ? ` · ready ${ready}` : ''}`
		: `Joined server (pid ${state.hostPid ?? '?'})${ready ? ` · ready ${ready}` : ''}`
	const details = [
		['replay', perfMs('Active tab replayed')],
		['first draw', perfMs('First draw done')],
		['blobs', perfMs('Active tab blobs loaded')],
		['all tabs', perfMs('All tabs loaded')],
	].filter(([, ms]) => !!ms).map(([label, ms]) => `${label} ${ms}`)
	queueLocalBlock({
		type: 'startup',
		text: details.length > 0 ? `${firstLine}\n${details.join(' · ')}` : firstLine,
		ts: Date.now(),
	})
}

function showServerRestart(pid: number, startedAt?: string): void {
	queueLocalBlock({
		type: 'startup',
		text: `Server restarted (pid ${pid})`,
		ts: startedAt ? Date.parse(startedAt) : Date.now(),
	})
}

function sameMergeTs(a?: number, b?: number): boolean {
	// Persisted history and live.ason often agree on timestamps, but some callers
	// only have one side. Missing ts should not block dedupe.
	return a == null || b == null || a === b
}

function sameMergeBlock(a: Block, b: Block): boolean {
	if (a.type !== b.type) return false
	if (!sameMergeTs(a.ts, b.ts)) return false

	if (a.type === 'tool' && b.type === 'tool') {
		// Tool blocks are best matched by toolId. When that's missing, fall back to
		// the stable parts that survive replay: name, input and blob identity.
		if (a.toolId && b.toolId) return a.toolId === b.toolId
		const sameBlob = a.blobId == null || b.blobId == null || a.blobId === b.blobId
		return sameBlob && a.name === b.name && ason.stringify(a.input ?? null) === ason.stringify(b.input ?? null)
	}

	if (a.type === 'thinking' && b.type === 'thinking') {
		const sameBlob = a.blobId == null || b.blobId == null || a.blobId === b.blobId
		return sameBlob && a.text === b.text
	}

	if (a.type === 'error' && b.type === 'error') {
		const sameBlob = a.blobId == null || b.blobId == null || a.blobId === b.blobId
		return sameBlob && a.text === b.text
	}

	return 'text' in a && 'text' in b && a.text === b.text
}

function trimPersistedLiveOverlap(blocks: Block[], live: Block[]): Block[] {
	const maxOverlap = Math.min(blocks.length, live.length)
	for (let overlap = maxOverlap; overlap > 0; overlap--) {
		let matches = true
		for (let i = 0; i < overlap; i++) {
			const historyBlock = blocks[blocks.length - overlap + i]!
			const liveBlock = live[i]!
			if (sameMergeBlock(historyBlock, liveBlock)) continue
			matches = false
			break
		}
		if (matches) return live.slice(overlap)
	}
	return live
}

function historyWithLive(blocks: Block[], tab: Tab): Block[] {
	const live = trimPersistedLiveOverlap(blocks, tab.liveHistory ?? [])
	if (live.length === 0) return blocks
	return [...blocks, ...live]
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
	tab.history = historyWithLive(blockModule.historyToBlocks(tab.rawHistory!, tab.sessionId, tab.parentEntryCount, tab.forkedFrom, tab.model), tab)
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
	doneUnseen: string[] // background-complete tabs that still deserve a ✓
}

function defaultClientState(): ClientStateFile {
	return { lastTab: null, peak: 0, peakCols: 0, model: null, doneUnseen: [] }
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function isMissingFileError(err: unknown): boolean {
	return !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}

function loadClientState(): ClientStateFile {
	try {
		const data = ason.parse(readFileSync(CLIENT_STATE_PATH, 'utf-8')) as any
		return {
			lastTab: data?.lastTab ?? null,
			peak: data?.peak ?? 0,
			peakCols: data?.peakCols ?? 0,
			model: data?.model ?? null,
			doneUnseen: Array.isArray(data?.doneUnseen) ? data.doneUnseen.filter((item: any) => typeof item === 'string') : [],
		}
	} catch (err) {
		if (!isMissingFileError(err)) log.error('failed to load client state', { error: errorMessage(err) })
		return defaultClientState()
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
				doneUnseen: state.tabs.filter((item) => item.doneUnseen).map((item) => item.sessionId),
			}) + '\n',
		)
	} catch (err) {
		log.error('failed to save client state', { error: errorMessage(err) })
	}
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
let pendingOpen: 'open' | 'fork' | 'resume' | false = false

function sendCommand(type: CommandType, text?: string): void {
	const tab = currentTab()
	if (type === 'open') pendingOpen = text?.startsWith('fork:') ? 'fork' : 'open'
	if (type === 'resume') pendingOpen = 'resume'
	ipc.appendCommand(makeCommand(type, tab?.sessionId, text))
}

function makeCommand(type: CommandType, sessionId: string | undefined, text?: string): Command {
	switch (type) {
		case 'prompt':
			return { type, sessionId, text: text ?? '' }
		case 'open':
			if (text?.startsWith('fork:')) return { type, sessionId, forkSessionId: text.slice(5) }
			if (text?.startsWith('after:')) return { type, sessionId, afterSessionId: text.slice(6) }
			return { type, sessionId }
		case 'resume':
			return text ? { type, sessionId, selector: text } : { type, sessionId }
		case 'move': {
			const position = parseInt(text ?? '', 10)
			return { type, sessionId, position: Number.isFinite(position) ? position : 0 }
		}
		case 'continue':
		case 'close':
		case 'abort':
		case 'reset':
		case 'compact':
			return { type, sessionId }
		case 'rename':
			return { type, sessionId, name: text ?? '' }
		case 'spawn':
			throw new Error('spawn commands must be created explicitly')
	}
}

function hasTrailingAssistantText(tab: Tab, text: string): boolean {
	return trailingAssistantText(tab) === text
}


function assistantChainId(block: Block): string | null {
	return liveEventBlocks.assistantChainId(block)
}

function isContinuableStatusBlock(block: Block): boolean {
	if (block.type === 'error') return true
	if (block.type === 'info') return block.text === '[paused]' || block.text?.startsWith('[interrupted]')
	return false
}

function canContinueTab(tab: Tab | null): boolean {
	if (!tab) return false
	if (state.busy.get(tab.sessionId)) return false
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]!
		if (block.type === 'tool') continue
		if (block.type === 'info' && !isContinuableStatusBlock(block)) continue
		return isContinuableStatusBlock(block)
	}
	return false
}

function canContinueCurrentTurn(): boolean {
	return canContinueTab(currentTab())
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
	const tab = makeTab(
		info.id,
		meta?.name ?? info.name ?? info.id,
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
		tab.usage.cacheRead += entry.usage.cacheRead ?? 0
		tab.usage.cacheCreation += entry.usage.cacheCreation ?? 0
	}
	if (meta?.context) {
		tab.contextUsed = meta.context.used
		tab.contextMax = meta.context.max
	}
	tab.forkedFrom = meta?.forkedFrom ?? parentId
	return tab
}

function applySessionList(items: SharedSessionInfo[], preferredSession = ''): void {
	const previousTabs = state.tabs
	const previousById = new Map(previousTabs.map((tab) => [tab.sessionId, tab]))
	const previousSession = previousTabs[state.activeTab]?.sessionId ?? ''
	const previousIndex = state.activeTab
	const newTabs: Tab[] = []
	const openedTabs: Tab[] = []
	const isFork = pendingOpen === 'fork'
	let openedSessionId = ''
	for (const s of items) {
		const existing = previousById.get(s.id)
		if (existing) {
			existing.name = s.name ?? s.id
			existing.cwd = s.cwd || existing.cwd
			existing.model = s.model || existing.model
			newTabs.push(existing)
		} else {
			openedSessionId = s.id
			const tab = makeTabFromDisk(s)
			openedTabs.push(tab)
			newTabs.push(tab)
		}
	}
	const grew = newTabs.length > previousTabs.length
	state.tabs = newTabs
	const openIds = new Set(newTabs.map((tab) => tab.sessionId))
	pruneRecentTabs(openIds)

	const targetSession = previousTabs.length === 0 && preferredSession && openIds.has(preferredSession)
		? preferredSession
		: pickActiveSessionAfterSessionListChange({
			previousSession,
			previousIndex,
			previousLength: previousTabs.length,
			newSessionIds: newTabs.map((tab) => tab.sessionId),
			recentTabs: state.recentTabs,
			pendingOpen,
			openedSessionId,
		})

	const nextIndex = newTabs.findIndex((tab) => tab.sessionId === targetSession)
	state.activeTab = nextIndex >= 0 ? nextIndex : Math.max(0, Math.min(previousIndex, newTabs.length - 1))
	const newSession = state.tabs[state.activeTab]?.sessionId ?? ''
	const active = state.tabs[state.activeTab]
	if (active && !active.loaded) ensureTabLoaded(active)
	if (active) loadTabBlobs(active)
	if (active) rememberTab(active.sessionId)
	if (previousTabs.length > 0) {
		for (const tab of openedTabs) {
			if (tab === active) continue
			if (!tab.loaded) ensureTabLoaded(tab)
			loadTabBlobs(tab)
		}
	}
	flushPendingEntries()
	if (isFork && grew && previousSession) {
		const prevTab = newTabs.find((tab) => tab.sessionId === previousSession)
		const newTab = openedSessionId ? newTabs.find((tab) => tab.sessionId === openedSessionId) : undefined
		if (prevTab?.inputDraft && newTab) newTab.inputDraft = prevTab.inputDraft
	}
	pendingOpen = false
	if (previousSession !== newSession && onTabSwitch) onTabSwitch(previousSession, newSession)
	onChange(false)
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
	if (shared.openSessions.length > 0) applySessionList(shared.openSessions)
	applySharedStatus(shared)
}

function handleEvent(event: any): void {
	if (event.type === 'host-released') return
	if (event.type === 'runtime-start') {
		if (event.pid !== state.pid) showServerRestart(event.pid, event.startedAt)
		return
	}

	if (event.type === 'prompt') {
		if (event.label === 'steering') cancelDelayedPaused(event.sessionId ?? null)
		else flushDelayedPaused(event.sessionId ?? null)
		addBlockToTab(event.sessionId, {
			type: 'user',
			text: event.text,
			source: typeof event.source === 'string' ? event.source : undefined,
			status: event.label,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
		return
	}

	if (event.type === 'stream-start' && event.sessionId) {
		flushDelayedPaused(event.sessionId)
		const tab = tabForSession(event.sessionId)
		if (tab) applyLiveEventToTab(tab, event)
		return
	}

	if (event.type === 'stream-delta' && event.sessionId && event.text) {
		flushDelayedPaused(event.sessionId)
		const tab = tabForSession(event.sessionId)
		if (tab && applyLiveEventToTab(tab, event).changed) repaintIfActive(tab)
		return
	}

	if (event.type === 'stream-end' && event.sessionId) {
		flushDelayedPaused(event.sessionId)
		const tab = tabForSession(event.sessionId)
		if (!tab) return
		applyLiveEventToTab(tab, event)
		if (event.usage) {
			tab.usage ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
			tab.usage.input += event.usage.input ?? 0
			tab.usage.output += event.usage.output ?? 0
			tab.usage.cacheRead += event.usage.cacheRead ?? 0
			tab.usage.cacheCreation += event.usage.cacheCreation ?? 0
		}
		if (event.contextUsed != null) tab.contextUsed = event.contextUsed
		if (event.contextMax != null) tab.contextMax = event.contextMax
		repaintIfActive(tab)
		return
	}

	if (event.type === 'response') {
		flushDelayedPaused(event.sessionId ?? null)
		const tab = tabForSession(event.sessionId ?? null)
		if (!tab) return
		applyLiveEventToTab(tab, { type: 'stream-end' })
		if (event.isError) {
			applyLiveEventToTab(tab, event)
			onChange(false)
		} else if (event.text && !hasTrailingAssistantText(tab, event.text)) {
			addBlockToTab(event.sessionId ?? null, {
				type: 'assistant',
				text: event.text,
				ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
			})
		}
		return
	}

	if (event.type === 'info') {
		const sessionId = event.sessionId ?? null
		const tab = tabForSession(sessionId)
		if (tab) applyLiveEventToTab(tab, { type: 'stream-end' })

		// Give steering a brief chance to arrive before we render [paused]. If the
		// very next event is a steering prompt, we cancel this pending notice and
		// avoid the one-frame blink between abort and steer.
		if (event.level !== 'error' && event.text === '[paused]') {
			scheduleDelayedPaused(sessionId, {
				type: 'info',
				text: event.text,
				ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
			})
			return
		}

		flushDelayedPaused(sessionId)
		if (tab) {
			applyLiveEventToTab(tab, event)
			onChange(false)
		}
		return
	}

	if (event.type === 'tool-call' && event.sessionId) {
		flushDelayedPaused(event.sessionId)
		const tab = tabForSession(event.sessionId)
		if (tab) {
			applyLiveEventToTab(tab, event)
			onChange(false)
		}
		return
	}

	if (event.type === 'tool-result' && event.sessionId) {
		flushDelayedPaused(event.sessionId)
		const tab = state.tabs.find((item) => item.sessionId === event.sessionId)
		const toolBlock = tab ? applyLiveEventToTab(tab, event).toolBlock : null
		if (toolBlock) {
			delete toolBlock.blobLoaded
			onChange(false)
			// IPC tool-result events only carry a truncated preview. Reload the
			// tool's blob in the background so edit/read blocks show full output.
			if (toolBlock.blobId) {
				void (async () => {
					const loaded = await blockModule.loadBlobs([toolBlock])
					if (loaded <= 0) return
					touchTab(tab!)
					onChange(false)
				})()
			}
		}
		return
	}

	if (event.type === 'draft_saved' && event.sessionId) {
		flushDelayedPaused(event.sessionId)
		// Another client saved a draft. Update the in-memory copy for that
		// tab. If it's the active tab and our prompt is empty, show it.
		const tab = state.tabs.find(t => t.sessionId === event.sessionId)
		if (tab) {
			const text = draftModule.loadDraft(event.sessionId)
			tab.inputDraft = text
			const active = currentTab()
			if (active?.sessionId === event.sessionId && onDraftArrived) onDraftArrived(text)
		}
	}
}


function sessionInfoFromMeta(meta: SessionMeta, _index: number): SharedSessionInfo {
	return {
		id: meta.id,
		name: meta.name,
		cwd: meta.workingDir ?? '',
		model: meta.model,
	}
}

function initializeSessions(shared: SharedState): void {
	const items = shared.openSessions.length > 0
		? shared.openSessions
		: sessionStore.loadAllSessionMetas().map(sessionInfoFromMeta)
	if (items.length === 0) {
		applySharedStatus(shared)
		return
	}

	const saved = loadClientState()
	const t0 = performance.now()
	applySessionList(items, saved.lastTab ?? '')
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

	if (!config.backgroundLoadTabs) {
		showStartupSummary()
		return
	}

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
	showStartupSummary()
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

function startWatchingIpcState(): SharedState {
	if (!ipcStateFile) {
		// Bootstrap state belongs in state.ason. New clients read it once, then keep
		// following changes via the file watcher while tailing only future events.
		ipcStateFile = liveFiles.liveFile(`${STATE_DIR}/ipc/state.ason`, ipc.readState())
		liveFiles.onChange(ipcStateFile, () => {
			applySharedState(ipcStateFile!)
			onChange(false)
		})
	}
	return ipcStateFile
}

function resetForTests(): void {
	pendingEntries = []
	for (const pending of delayedPausedNotices.values()) clearTimeout(pending.timer)
	delayedPausedNotices = new Map()
	onChange = () => {}
	onTabSwitch = null
	onDraftArrived = null
	pendingOpen = false
	hostLockState = null
	ipcStateFile = null
	state.recentTabs = []
	state.startupSummaryShown = true
	state.hostVersionStatus = 'idle'
	state.hostVersion = ''
}

function startClient(signal: AbortSignal): void {
	startWatchingHostLock()
	const shared = startWatchingIpcState()
	openaiUsage.onChange(() => onChange(false))

	void (async () => {
		for await (const event of ipc.tailEvents(signal)) {
			handleEvent(event)
		}
	})()

	initializeSessions(shared)
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
	canContinueCurrentTurn,
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

