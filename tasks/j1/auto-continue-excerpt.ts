	if (sessionStore.loadSessionMeta(sessionId)?.spawnKind !== 'subagent') return
	sessionStore.updateMeta(sessionId, { spawnKind: 'subagent-leave-open' })
	emitInfo(sessionId, 'Subagent promoted from `subagent` to `subagent-leave-open` - this session will not be closed automatically.')
}

// Restart evidence can resume only the unfinished turn that precedes it. Checking
// the same projection used by manual continue prevents later UI-only history from
// reviving an old interruption that was already rejected as "Nothing to continue".
function shouldAutoContinue(entries: HistoryEntry[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!
		if (entry.type === 'turn_end') return false
		const interrupted = (entry.type === 'assistant' || entry.type === 'thinking') && entry.interruptedBy === 'restart'
		if (interrupted || (entry.type === 'log' && entry.text === RESTARTED_TEXT)) return continuation.actionForHistory(entries.slice(0, i + 1)) !== false
	}
	return false
}

function answeredIntroNeedsContinue(entries: HistoryEntry[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!
