import type { SharedSessionInfo } from '../common/ipc.ts'
import type { Tab } from './app.ts'
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
	const previousSession = previousTabs[model.focusedTabIndex]?.sessionId ?? ''
	const previousIndex = model.focusedTabIndex
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
			existing.currentLog = s.currentLog || existing.currentLog
			existing.attention = s.attention
			existing.continuation = s.continuation
			newTabs.push(existing)
		} else {
			openedSessionId = s.id
			const tab = ctx.makeTabFromDisk(s)
			openedTabs.push(tab)
			newTabs.push(tab)
		}
	}

	const grew = newTabs.length > previousTabs.length
	const shrank = newTabs.length < previousTabs.length
	const returnToSession = state.returnToBySession.get(previousSession)
	model.tabs = newTabs
	const openIds = new Set(newTabs.map((tab) => tab.sessionId))
	ctx.pruneRecentTabs(openIds)
	for (const sessionId of state.returnToBySession.keys()) if (!openIds.has(sessionId)) state.returnToBySession.delete(sessionId)
	if (grew && openedSessionId && previousSession && state.pendingOpen) state.returnToBySession.set(openedSessionId, previousSession)

	const targetSession = previousTabs.length === 0 && preferredSession && openIds.has(preferredSession) ? preferredSession : clientTabs.pickFocusedSessionAfterSessionListChange({
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
	model.focusedTabIndex = nextIndex >= 0 ? nextIndex : Math.max(0, Math.min(previousIndex, newTabs.length - 1))
	const newSession = model.tabs[model.focusedTabIndex]?.sessionId ?? ''
	const focused = model.tabs[model.focusedTabIndex]
	if (focused && !focused.loaded) ctx.ensureTabLoaded(focused)
	if (focused) ctx.loadTabBlobs(focused)
	if (focused) focused.attention = undefined
	if (focused) ctx.rememberTab(focused.sessionId)
	if (previousTabs.length > 0) loadOpenedBackground(openedTabs, focused, ctx)
	ctx.flushPendingEntries()
	copyForkDraft(isFork, grew, previousSession, openedSessionId, newTabs)
	if (state.pendingOpen === 'resume' && grew && focused && openedTabs.includes(focused)) ctx.addTabNoticeToTab(focused, 'Tab restored.')
	if (shrank) ctx.showRestoreTabHint()
	if (state.pendingOpen === 'resume' && grew) ctx.clearRestoreTabHint()
	if (grew && openedSessionId) state.pendingOpen = false
	if (previousSession !== newSession) ctx.onTabSwitch(previousSession, newSession)
	ctx.onChange(previousTabs.length > 0 && previousSession !== newSession)
}

function loadOpenedBackground(openedTabs: Tab[], focused: Tab | undefined, ctx: any): void {
	for (const tab of openedTabs) {
		if (tab === focused) continue
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
