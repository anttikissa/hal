function startPromptAmendCommand(sessionId: string, text: string, source?: string, displayText?: string): Promise<void> {
	return trackPendingPrompt(sessionId, (pending, previous) => handlePromptAmendCommand(sessionId, text, source, displayText, pending, previous))
}

function abortPendingPrompt(sessionId: string, abortText: string): Promise<void> | false {
	const pending = state.pendingPrompts.get(sessionId)
	if (!pending) return false
	pending.controller.abort(abortText)
	return pending.task
}

async function resolvePromptParts(sessionId: string, text: string, displayText?: string): Promise<UserPart[]> {
	if (displayText && displayText !== text) return [{ type: 'text', text, displayText }]
	return (await attachments.resolve(sessionId, text)).logParts
}

function hasTurnContentAfterLastUser(entries: HistoryEntry[]): boolean {
	let lastUser = -1
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === 'user') {
			lastUser = i
			break
		}
	}
	if (lastUser < 0) return true
	for (const entry of entries.slice(lastUser + 1)) {
		if (entry.type === 'assistant' || entry.type === 'thinking' || entry.type === 'tool_call' || entry.type === 'tool_result') return true
	}
	return false
}

function hasLiveTurnContent(sessionId: string): boolean {
	for (const block of sessionStore.loadLive(sessionId).blocks) {
		if (block?.type === 'assistant' || block?.type === 'thinking' || block?.type === 'tool') return true
	}
	return false
}

async function continueTurn(sessionId: string, continuation: PendingContinuation): Promise<void> {
	const pendingPrompt = abortPendingPrompt(sessionId, '')
	if (pendingPrompt) await pendingPrompt
	if (agentLoop.isWorking(sessionId)) {
		if (agentLoop.hasPauseBeforeTools(sessionId)) return
		const settled = agentLoop.abortAndWait(sessionId, '')
		if (settled) await settled
	}
	if (continuation.canceled) return
	const pendingTools = sessionStore.findPendingTools(sessionId)
	if (pendingTools && !pendingTools.allAnswered) return
	promptQueue.setHeld(sessionId, false)
	await continuePendingTools(sessionId)
	if (continuation.canceled || sessionStore.findPendingTools(sessionId)) return
	if (pendingTools?.aborted) {
		sessionStore.appendHistory(sessionId, [{ type: 'turn_end', status: 'aborted', abortText: USER_PAUSED_TEXT, ts: new Date().toISOString() }])
		emitHistoryUpdated(sessionId)
		return
	}
	void runGeneration(sessionId, '')
}

function requestContinue(sessionId: string): void {
	if (state.continuingTurns.has(sessionId)) return
	const continuation = { canceled: false }
	state.continuingTurns.set(sessionId, continuation)
	const task = continueTurn(sessionId, continuation)
	void task.then(
		() => { if (state.continuingTurns.get(sessionId) === continuation) state.continuingTurns.delete(sessionId) },
		() => { if (state.continuingTurns.get(sessionId) === continuation) state.continuingTurns.delete(sessionId) },
	)
}

function requestInitialTurn(sessionId: string): void {
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return
	if (!isInitialTurn(meta.model ?? models.defaultModel(), sessionStore.loadAllHistory(sessionId))) return
	requestContinue(sessionId)
}

async function amendLastPrompt(sessionId: string, text: string, source?: string, displayText?: string): Promise<boolean> {
	const entries = sessionStore.loadHistory(sessionId)
	if (entries.length === 0 || hasTurnContentAfterLastUser(entries) || hasLiveTurnContent(sessionId)) return false
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		if (entry?.type !== 'user') continue
		entries[i] = {
			type: 'user',
			id: entry.id,
			parts: await resolvePromptParts(sessionId, text, displayText),
			source,
			ts: entry.ts ?? new Date().toISOString(),
		}
		const { oldLog, newLog, entryCount } = sessionStore.rewriteHistoryForRebase(sessionId, entries)
		resetProviderConversation(sessionId)
		sessionStore.clearLive(sessionId)
		ipc.appendEvent({ type: 'history-replaced', sessionId, oldLog, newLog, entryCount })
		return true
	}
	return false
}

function cancelAmendedPrompt(sessionId: string): void {
	const canceled = sessionStore.cancelTailTurn(sessionId)
	if (!canceled) return
	resetProviderConversation(sessionId)
	sessionStore.clearLive(sessionId)
	ipc.appendEvent({ type: 'history-replaced', sessionId, newLog: canceled.logName, entryCount: canceled.entryCount })
	ipc.updateState((shared) => updateSharedTurnStatus(shared, sessionId, false))
}

async function handlePromptAmendCommand(sessionId: string, text: string, source: string | undefined, displayText: string | undefined, pending: PendingPrompt, previous?: PendingPrompt): Promise<void> {
	if (previous) {
		previous.controller.abort('')
		await previous.task
	}
	if (agentLoop.isWorking(sessionId)) {
		const settled = agentLoop.abortAndWait(sessionId, '')
		if (settled) await settled
	}
	if (!text.trim()) {
		cancelAmendedPrompt(sessionId)
		return
	}
	if (!await amendLastPrompt(sessionId, text, source, displayText)) {
		cancelAmendedPrompt(sessionId)
		await handlePrompt(sessionId, text, undefined, source, displayText, pending)
		return
	}
	await runGeneration(sessionId, '', undefined, undefined, pending)
}
