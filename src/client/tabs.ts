type PendingOpen = 'open' | 'fork' | 'resume' | false

type PickActiveOptions = {
	previousSession: string; previousIndex: number; previousLength: number; newSessionIds: string[]; recentTabs: string[]
	pendingOpen: PendingOpen; openedSessionId: string; returnToSession?: string
}

function pickActiveSessionAfterSessionListChange(opts: PickActiveOptions): string {
	const { previousSession, previousIndex, previousLength, newSessionIds, recentTabs, pendingOpen, openedSessionId, returnToSession } = opts
	const openIds = new Set(newSessionIds)
	const grew = newSessionIds.length > previousLength
	const shrank = newSessionIds.length < previousLength
	const activeTabClosed = previousSession !== '' && !openIds.has(previousSession)
	if (grew && pendingOpen && openedSessionId) return openedSessionId
	if (previousSession && openIds.has(previousSession)) return previousSession
	if (shrank && activeTabClosed) {
		if (returnToSession && openIds.has(returnToSession)) return returnToSession
		const rightNeighborSlot = Math.min(previousIndex, newSessionIds.length - 1)
		return newSessionIds[rightNeighborSlot] ?? ''
	}
	for (let i = recentTabs.length - 1; i >= 0; i--) {
		const sessionId = recentTabs[i]!
		if (openIds.has(sessionId)) return sessionId
	}
	const fallbackIndex = previousIndex > 0 ? Math.min(previousIndex - 1, newSessionIds.length - 1) : 0
	return newSessionIds[fallbackIndex] ?? newSessionIds[0] ?? ''
}

export const clientTabs = { pickActiveSessionAfterSessionListChange }
