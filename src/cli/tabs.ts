// Tab state management — hydration, navigation, sync.

import type { Block } from './blocks.ts'
import type { Transport } from './transport.ts'
import type { SessionInfo } from '../protocol.ts'
import type { StartupPerfHolder } from '../perf/startup-client-perf.ts'
import { startupClientPerf } from '../perf/startup-client-perf.ts'
import { progressiveHydrate } from '../session/progressive-hydrate.ts'
import { replay } from '../session/replay.ts'
import { draft } from './draft.ts'
import { prompt } from './prompt.ts'
import { clientState } from '../client-state.ts'
import { startupTrace } from '../perf/startup-trace.ts'

export interface TabState {
	sessionId: string
	blocks: Block[]
	info: SessionInfo
	busy: boolean
	pausing: boolean
	inputHistory: string[]
	inputDraft: string
	contentHeight: number
	context?: { used: number; max: number; estimated?: boolean }
	loadingHistory: boolean
	question?: { id: string; text: string }
	doneUnseen?: boolean
	hydrated: boolean
}

export interface ClientState {
	tabs: TabState[]
	activeTabIndex: number
	connected: boolean
}

export interface TabHost {
	state: ClientState
	transport: Transport
	startupPerf: StartupPerfHolder
	pendingOpen: boolean
	activeTab(): TabState | null
	onUpdate: () => void
}

export const clientConfig = {
	startupProgressiveMinMessages: 400,
	startupTailMessageCount: 120,
}

async function hydrateTab(host: TabHost, tab: TabState, opts?: { progressiveStartup?: boolean; startupTrace?: boolean }): Promise<number> {
	const startedAt = Date.now()
	const inputDraftPromise = draft.loadDraft(tab.sessionId)
	const loadStartedAt = Date.now()
	const hydration = await host.transport.hydrateSession(tab.sessionId)
	const replayMessages = hydration.replayMessages
	const loadMs = Date.now() - loadStartedAt
	if (opts?.startupTrace) {
		const t = hydration.timing
		const timingDetail = t
			? `read ${Math.round(t.readMs)}ms + parse ${Math.round(t.parseMs)}ms + fork ${Math.round(t.forkMs)}ms`
			: `${Math.round(loadMs)}ms`
		startupTrace.mark('active-messages-loaded', `${startupTrace.summarizeMessages(replayMessages)}; ${timingDetail} (${tab.sessionId})`)
	}
	const shouldProgressive = !!opts?.progressiveStartup && replayMessages.length >= clientConfig.startupProgressiveMinMessages
	if (shouldProgressive) {
		const tailCount = Math.max(1, clientConfig.startupTailMessageCount)
		const tailStart = Math.max(0, replayMessages.length - tailCount)
		const olderMessages = replayMessages.slice(0, tailStart)
		const tailMessages = replayMessages.slice(tailStart)
		const hydrateStartedAt = Date.now()
		const tailBlocks = await replay.replayToBlocks(tab.sessionId, tailMessages, tab.info.model, tab.busy, {
			toolResultSourceMessages: replayMessages,
		})
		const hydrateMs = Date.now() - hydrateStartedAt
		tab.blocks.push(...tailBlocks)
		if (opts?.startupTrace) {
			startupTrace.mark('active-tail-hydrated', `last ${tailMessages.length} messages in ${Math.max(0, Math.round(hydrateMs))}ms (${tab.sessionId})`)
		}
		progressiveHydrate.hydrateInBackground(tab, olderMessages, replayMessages, {
			startupTraceMessageCount: opts?.startupTrace ? replayMessages.length : undefined,
			onDone: () => {
				startupClientPerf.appendIfReady(host.startupPerf, host.activeTab()?.blocks ?? null)
				host.onUpdate()
			},
		})
	} else {
		const hydrateStartedAt = Date.now()
		const blocks = await replay.replayToBlocks(tab.sessionId, replayMessages, tab.info.model, tab.busy)
		const hydrateMs = Date.now() - hydrateStartedAt
		tab.blocks.push(...blocks)
		if (opts?.startupTrace) {
			startupTrace.mark('active-tail-hydrated', `${replayMessages.length} messages in ${Math.max(0, Math.round(hydrateMs))}ms (${tab.sessionId})`)
		}
		tab.loadingHistory = false
	}
	tab.inputHistory = hydration.inputHistory
	tab.inputDraft = await inputDraftPromise
	tab.hydrated = true
	return Date.now() - startedAt
}

async function hydrateNonActiveTabs(host: TabHost, activeSessionId: string | null): Promise<void> {
	let hydratedTabs = 0
	for (const tab of host.state.tabs) {
		if (tab.sessionId === activeSessionId || tab.hydrated) continue
		try {
			await hydrateTab(host, tab)
			hydratedTabs += 1
		} catch {}
	}
	if (hydratedTabs > 0) {
		startupTrace.mark('other-tabs-hydrated', `${hydratedTabs} tabs`)
		startupClientPerf.appendIfReady(host.startupPerf, host.activeTab()?.blocks ?? null)
		host.onUpdate()
	}
}

async function syncTabs(host: TabHost, sessions: SessionInfo[]): Promise<void> {
	const current = new Map(host.state.tabs.map(t => [t.sessionId, t]))
	const newTabs: TabState[] = []
	let newTabId: string | null = null
	for (const info of sessions) {
		const existing = current.get(info.id)
		if (existing) { existing.info = info; existing.context = info.context ?? existing.context; newTabs.push(existing) }
		else { newTabs.push({ sessionId: info.id, blocks: [], info, busy: false, pausing: false, inputHistory: [], inputDraft: '', contentHeight: 0, context: info.context, loadingHistory: false, hydrated: false }); newTabId = info.id }
	}
	const prevId = host.state.tabs[host.state.activeTabIndex]?.sessionId
	host.state.tabs = newTabs
	if (newTabId && host.pendingOpen) {
		host.pendingOpen = false
		const idx = newTabs.findIndex(t => t.sessionId === newTabId)
		if (idx >= 0) host.state.activeTabIndex = idx
	} else {
		const kept = newTabs.findIndex(t => t.sessionId === prevId)
		if (kept >= 0) {
			host.state.activeTabIndex = kept
		} else {
			// Tab was closed — stay at same index (tab to the right slides in)
			const prevIdx = host.state.activeTabIndex
			host.state.activeTabIndex = Math.min(prevIdx, newTabs.length - 1)
		}
	}
	const hydrateBySession = new Map<string, number>()
	for (const tab of newTabs) {
		if (!current.has(tab.sessionId)) {
			const hydrate = await hydrateTab(host, tab)
			hydrateBySession.set(tab.sessionId, hydrate)
		}
	}
	const newId = host.state.tabs[host.state.activeTabIndex]?.sessionId
	if (newId !== prevId) switchToActiveTab(host)
	const active = host.activeTab()
	if (active && host.startupPerf.state && host.startupPerf.state.tabMs === null) {
		const hydrate = hydrateBySession.get(active.sessionId) ?? null
		startupClientPerf.renderAndCapture(host.startupPerf, active.blocks, active.sessionId, host.onUpdate, hydrate)
		return
	}
	startupClientPerf.appendIfReady(host.startupPerf, host.activeTab()?.blocks ?? null)
	host.onUpdate()
}

function applyTabToPrompt(tab: TabState): void {
	prompt.setHistory(tab.inputHistory)
	if (tab.inputDraft) prompt.setText(tab.inputDraft)
	if (tab.question) prompt.setQuestion(tab.question.text)
}

function switchToActiveTab(host: TabHost): void {
	prompt.reset()
	const tab = host.activeTab()
	if (tab) {
		tab.doneUnseen = false
		if (!tab.hydrated) {
			void hydrateTab(host, tab).then(() => {
				applyTabToPrompt(tab)
				host.onUpdate()
			}).catch(() => {})
		}
		applyTabToPrompt(tab)
		clientState.saveLastTab(tab.sessionId)
	}
}

function nextTab(host: TabHost): void {
	if (host.state.tabs.length <= 1) return
	saveDraft(host)
	host.state.activeTabIndex = (host.state.activeTabIndex + 1) % host.state.tabs.length
	switchToActiveTab(host)
}

function prevTab(host: TabHost): void {
	if (host.state.tabs.length <= 1) return
	saveDraft(host)
	const len = host.state.tabs.length
	host.state.activeTabIndex = (host.state.activeTabIndex - 1 + len) % len
	switchToActiveTab(host)
}

function switchToTab(host: TabHost, idx: number): void {
	if (idx < 0 || idx >= host.state.tabs.length || idx === host.state.activeTabIndex) return
	saveDraft(host)
	host.state.activeTabIndex = idx
	switchToActiveTab(host)
}

async function saveDraft(host: TabHost): Promise<void> {
	const tab = host.activeTab()
	if (!tab) return
	if (prompt.hasQuestion()) return
	tab.inputDraft = prompt.text()
	try { await draft.saveDraft(tab.sessionId, tab.inputDraft) } catch {}
}

function onSubmitTab(host: TabHost): void {
	const tab = host.activeTab()
	if (!tab) return
	tab.inputDraft = ''
	draft.clearDraft(tab.sessionId).catch(() => {})
}

function clearQuestion(host: TabHost): void {
	const tab = host.activeTab()
	if (tab) tab.question = undefined
}

function markPausing(host: TabHost): void {
	const tab = host.activeTab()
	if (!tab || !tab.busy) return
	tab.pausing = true
	tab.blocks.push({ type: 'info', text: '[pausing...]' })
}

export const tabs = {
	hydrateTab,
	hydrateNonActiveTabs,
	syncTabs,
	applyTabToPrompt,
	switchToActiveTab,
	nextTab,
	prevTab,
	switchToTab,
	saveDraft,
	onSubmitTab,
	clearQuestion,
	markPausing,
}
