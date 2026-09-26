}

const SIDE_EFFECT_TOOL_NAMES = new Set(['bash', 'edit', 'write', 'eval', 'send', 'spawn_agent'])

// Inbound messages are displayed as user blocks, but are not text typed in this
// terminal. Never offer one for the previous-prompt edit shortcut.
function lastUserBlock(tab: (typeof client.state.tabs)[number] | null): any | null {
	if (!tab) return null
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]
		if (block?.type === 'user' && !block.source) return block
	}
	return null
}

function blocksAfterLastUser(tab: (typeof client.state.tabs)[number]): any[] {
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]
		if (block?.type === 'user' && !block.source) return tab.history.slice(i + 1)
	}
	return tab.history
}

function hasVisibleOutputAfterLastUser(tab: (typeof client.state.tabs)[number]): boolean {
	for (const block of blocksAfterLastUser(tab)) {
		if (block.type !== 'log' || block.text !== '[paused]') return true
	}
	return false
}

function hasSideEffectfulToolAfterLastUser(tab: (typeof client.state.tabs)[number]): boolean {
	for (const block of blocksAfterLastUser(tab)) {
		if (block.type === 'tool' && SIDE_EFFECT_TOOL_NAMES.has(block.name)) return true
	}
	return false
}

function beginPreviousPromptEdit(): boolean {
	if (prompt.text() !== '') return false
	const tab = client.currentTab()
	if (!tab) return false
	const pendingText = client.state.pendingPromptTexts.get(tab.sessionId)
	const block = pendingText ? null : lastUserBlock(tab)
	const originalText = pendingText ?? block?.actualText ?? block?.text ?? client.getInputHistory().at(-1)
	if (!originalText) return false
	const working = client.isWorking()
	if (!working) return false
	const visibleOutput = !pendingText && hasVisibleOutputAfterLastUser(tab)
	const sideEffectfulTool = !pendingText && hasSideEffectfulToolAfterLastUser(tab)
	let mode: 'amend' | 'cancel' | 'side-effect-copy' = 'amend'
	if (visibleOutput) mode = sideEffectfulTool ? 'side-effect-copy' : 'cancel'
	promptEdit.start({
		sessionId: tab.sessionId,
		mode,
		originalText,
		pausedWorkingTurn: working,
		block: mode === 'amend' ? block ?? undefined : undefined,
	})
	prompt.setText(originalText)
	if (working) client.sendCommand('abort', mode === 'amend' || mode === 'cancel' ? '' : undefined)
	return true
}

function continueAfterPromptEdit(active: NonNullable<typeof promptEdit.state.active>): void {
	const shouldContinue = active.mode === 'amend' || active.pausedWorkingTurn
	promptEdit.cancel()
	prompt.clear()
	clearSavedPromptState()
	client.clearDraft(active.sessionId)
	if (shouldContinue) client.sendCommand('continue')
}

function submitPromptEdit(active: NonNullable<typeof promptEdit.state.active>, queue?: boolean): void {
	const text = prompt.submitText().trim()
	const amend = active.mode === 'amend' || active.mode === 'cancel'
	promptEdit.cancel()
	if (amend && text.startsWith('/')) client.sendCommand('prompt-amend', '')
	submit(undefined, queue, amend && !text.startsWith('/'))
}

function plainKey(k: KeyEvent, key: string): boolean {
	return k.key === key && !k.shift && !k.ctrl && !k.alt && !k.cmd
}

function handlePromptEditKey(k: KeyEvent, contentWidth: number): boolean {
	const active = promptEdit.activeFor(client.currentTab()?.sessionId)
	if (!active) return false
	if (k.key === 'enter' && !k.shift && !k.ctrl && !k.cmd) {
		submitPromptEdit(active, k.alt)
		return true
	}
	if (plainKey(k, 'down') && prompt.text() === active.originalText && !prompt.isBrowsingHistory() && prompt.atVerticalBoundary(1, contentWidth)) {
		continueAfterPromptEdit(active)
		return true
	}
	if (plainKey(k, 'escape')) {
		if (active.mode === 'amend') return true
		continueAfterPromptEdit(active)
		return true
	}
	return false
