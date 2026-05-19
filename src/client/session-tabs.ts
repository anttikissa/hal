import type { SharedSessionInfo } from '../ipc.ts'
import type { Tab } from '../client.ts'
import { clientTabs } from './tabs.ts'

type PendingOpen = 'open' | 'fork' | 'resume' | false
const state = { pendingOpen: false as PendingOpen, returnToBySession: new Map<string, string>() }

function reset(): void {
	state.pendingOpen = false
	state.returnToBySession.clear()
}

function apply(items: SharedSessionInfo[], preferredSession: string, ctx: any): void {
	const model = ctx.model
	const previousTabs = model.tabs as Tab[]
	const previousById = new Map<string, Tab>(previousTabs.map((tab) => [tab.sessionId, tab]))
	const previousSession = previousTabs[model.activeTab]?.sessionId ?? ''
	const previousIndex = model.activeTab
	const newTabs: Tab[] = []
	const openedTabs: Tab[] = []
	const isFork = state.pendingOpen === 'fork'
	const isOpen = state.pendingOpen === 'open'
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
			const tab = ctx.makeTabFromDisk(s)
			openedTabs.push(tab)
			newTabs.push(tab)
		}
	}

	const grew = newTabs.length > previousTabs.length
	const returnToSession = state.returnToBySession.get(previousSession)
	model.tabs = newTabs
	const openIds = new Set(newTabs.map((tab) => tab.sessionId))
	ctx.pruneRecentTabs(openIds)
	for (const sessionId of state.returnToBySession.keys()) if (!openIds.has(sessionId)) state.returnToBySession.delete(sessionId)
	if (grew && openedSessionId && previousSession && (isOpen || isFork)) state.returnToBySession.set(openedSessionId, previousSession)

	const targetSession = previousTabs.length === 0 && preferredSession && openIds.has(preferredSession) ? preferredSession : clientTabs.pickActiveSessionAfterSessionListChange({
		previousSession,
		previousIndex,
		previousLength: previousTabs.length,
		newSessionIds: newTabs.map((tab) => tab.sessionId),
		recentTabs: model.recentTabs,
		pendingOpen: state.pendingOpen,
		openedSessionId,
		returnToSession,
	})
	const nextIndex = newTabs.findIndex((tab) => tab.sessionId === targetSession)
	model.activeTab = nextIndex >= 0 ? nextIndex : Math.max(0, Math.min(previousIndex, newTabs.length - 1))
	const newSession = model.tabs[model.activeTab]?.sessionId ?? ''
	const active = model.tabs[model.activeTab]
	if (active && !active.loaded) ctx.ensureTabLoaded(active)
	if (active) ctx.loadTabBlobs(active)
	if (active) ctx.rememberTab(active.sessionId)
	if (previousTabs.length > 0) loadOpenedBackground(openedTabs, active, ctx)
	ctx.flushPendingEntries()
	copyForkDraft(isFork, grew, previousSession, openedSessionId, newTabs)
	if (isOpen && grew && active && openedTabs.includes(active)) ctx.addStartupSummaryToTab(active)
	state.pendingOpen = false
	if (previousSession !== newSession) ctx.onTabSwitch(previousSession, newSession)
	ctx.onChange(false)
}

function loadOpenedBackground(openedTabs: Tab[], active: Tab | undefined, ctx: any): void {
	for (const tab of openedTabs) {
		if (tab === active) continue
		if (!tab.loaded) ctx.ensureTabLoaded(tab)
		ctx.loadTabBlobs(tab)
	}
}

function copyForkDraft(isFork: boolean, grew: boolean, previousSession: string, openedSessionId: string, newTabs: Tab[]): void {
	if (!isFork || !grew || !previousSession) return
	const prevTab = newTabs.find((tab) => tab.sessionId === previousSession)
	const newTab = openedSessionId ? newTabs.find((tab) => tab.sessionId === openedSessionId) : undefined
	if (prevTab?.inputDraft && newTab) newTab.inputDraft = prevTab.inputDraft
}

export const sessionTabs = { state, reset, apply }
