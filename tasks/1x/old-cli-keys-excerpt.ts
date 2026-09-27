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
}

function submitPromptText(text: string, displayText: string | undefined, queue?: boolean, type: 'prompt' | 'prompt-amend' = 'prompt'): void {
	completion.dismiss()
	popup.close()
	promptEdit.cancel()
	// Human typing now uses the same prompt command path as inbox messages.
	// The runtime decides whether an working turn makes this behave like steering.
	client.sendCommand(type, text, displayText === text ? undefined : displayText, queue)
	prompt.clear()
	clearSavedPromptState()
	// The accepted prompt event updates the per-tab recall list in every client.
	client.onSubmit(text, true)
}

function handleLocalCommand(text: string): boolean {
	if (text === '/rebase') {
		client.sendCommand('rebase-start', rebaseRequestId())
		prompt.clear()
		clearSavedPromptState()
		client.onSubmit(text)
		return true
	}

	const parsed = clientLocalCommands.parse(text)
	if (!parsed) return false
	if (!clientLocalCommands.commandNames().includes(parsed.name)) return false

	prompt.clear()
	clearSavedPromptState()
	client.onSubmit(text)
	const result = clientLocalCommands.execute(text, {
		tabs: client.state.tabs,
		focusedTabIndex: client.state.focusedTabIndex,
		switchTab: client.switchTab,
		sendCommand: client.sendCommand,
	})
	if (result.output) client.addEntry(result.output)
	if (result.error) client.addEntry(result.error, 'error')
	if (result.quit) exitCli(0)
	return true
}

function submit(override?: string, queue?: boolean, amend?: boolean): void {
	if (prompt.isPasting() || renderStatus.introStreaming()) return
	const text = (override ?? prompt.submitText()).trim()
	const displayText = override === undefined ? prompt.text().trim() : undefined
	if (!text) return
	if (handleLocalCommand(text)) return
	submitPromptText(text, displayText, queue, amend ? 'prompt-amend' : 'prompt')
}

// ── Tab completion key handling ──────────────────────────────────────────────
// Tab triggers completion. While completion is active:
//   Tab / Down: cycle forward through candidates
//   Shift-Tab / Up: cycle backward
//   Enter / Space: accept selected item
//   Escape: dismiss
// Ambiguous choices are shown in the help line instead of printing into
// scrollback. Active state is tracked in `completion.state` and matters for
// what subsequent keys do.

function showCompletion(result: CompletionResult): void {
	completion.state.active = true
	completion.state.lastResult = result
	completionHints.set(result.hints)
	completion.state.selectedIndex = 0
	// If there's a common prefix longer than what we have, extend to it
	if (result.prefix.length > prompt.text().slice(0, prompt.cursorPos()).length) {
		const after = prompt.text().slice(prompt.cursorPos())
		prompt.setText(result.prefix + after, result.prefix.length)
	}
	// If only one match, apply it immediately
	if (result.items.length === 1) {
		const applied = completion.apply(prompt.text(), prompt.cursorPos(), result.items[0]!)
		prompt.setText(applied.text, applied.cursor)
		completion.dismiss()
	}
}

function handleCompletionKey(k: KeyEvent): boolean {
	// Tab triggers or cycles completion
	if (k.key === 'tab' && !k.ctrl && !k.alt && !k.cmd) {
		if (!completion.state.active) {
			// Trigger new completion
			const text = prompt.text()
			const cursor = prompt.cursorPos()
			const result = completion.complete(text, cursor, client.currentTab()?.cwd)
			const pending = completion.state.pending
			if (pending) {
				// Remote /cd: show the listing when it arrives, unless the user moved on.
				void pending.then((late) => {
					if (!late || completion.state.active || prompt.text() !== text || prompt.cursorPos() !== cursor) return
					showCompletion(late)
					draw()
				})
				return true
			}
			if (!result || result.items.length === 0) {
				// Slash commands are the only completion syntax. A plain, unselected Tab
				// in that syntax is an attempted completion even if nothing matches.
				const before = text.slice(0, cursor)
				return !k.shift && prompt.snapshotState().selAnchor === null && before.startsWith('/') && !before.includes('\n')
			}
			showCompletion(result)
			return true
		}
		// Already active: cycle forward
		completion.cycle(k.shift ? -1 : 1)
		return true
	}

	// Only handle remaining keys when completion is active
	if (!completion.state.active) return false

	// Arrow keys cycle through items
	if (k.key === 'down' && !k.ctrl && !k.alt) {
		completion.cycle(1)
		return true
	}
	if (k.key === 'up' && !k.ctrl && !k.alt) {
		completion.cycle(-1)
		return true
	}

	// Enter on a prompt that already matches the selected item: dismiss and let Enter
	// fall through to submit. This handles the common Tab→common-prefix→Enter flow,
	// where applying would only append a trailing space.
	if (k.key === 'enter' && !k.shift) {
		const item = completion.selectedItem()
		if (item && prompt.text() === item) {
			completion.dismiss()
			return false
		}
	}

	// Enter or space: accept selected item (but not shift+enter — that's newline)
	if ((k.key === 'enter' && !k.shift) || (k.char === ' ' && !k.ctrl && !k.alt)) {
		const item = completion.selectedItem()
		if (item) {
			const applied = completion.apply(prompt.text(), prompt.cursorPos(), item)
			prompt.setText(applied.text, applied.cursor)
		}
		completion.dismiss()
		return true
	}

	// Escape: dismiss
	if (k.key === 'escape') {
		completion.dismiss()
		return true
	}

	// Any other key: dismiss completion, let it fall through
	completion.dismiss()
	return false
}


function sendTabCommand(type: 'open' | 'resume', text?: string): void {
	client.sendCommand(type, text)
}

function chooseModelWithoutClearingDraft(model: string): void {
	const tab = client.currentTab()
	if (tab && models.resolveModel(model) === models.resolveModel(tab.model ?? models.defaultModel())) {
		draw()
		return
	}
	client.sendCommand('prompt', `/model ${model}`)
	draw()
}

function promptInputWidth(): number {
	return renderStatus.promptContentWidth(process.stdout.columns || 80)
}

function handlePromptKey(k: KeyEvent): boolean {
	const width = promptInputWidth()
	const previousRows = prompt.buildPrompt(width).lines.length
	if (!prompt.handleKey(k, width)) return false
	client.clearRestoreTabHint()
	// Moving a shorter prompt to the bottom crosses immutable scrollback rows into
	// the viewport. Only a canonical repaint can avoid duplicating those rows.
	const promptShrunk = prompt.buildPrompt(width).lines.length < previousRows
	draw(promptShrunk)
	return true
}

function clearSavedPromptState(): void {
	const tab = client.currentTab()
	if (tab) promptStates.delete(tab.sessionId)
}
function restorePromptEditForTab(tab: (typeof client.state.tabs)[number]): void {
	const saved = tab.inputDraftEdit
	if (!saved || promptEdit.activeFor(tab.sessionId)) return
	promptEdit.start({
		sessionId: tab.sessionId,
		mode: saved.mode,
		originalText: saved.originalText,
		pausedWorkingTurn: saved.pausedWorkingTurn,
		block: saved.mode === 'amend' ? lastUserBlock(tab) ?? undefined : undefined,
	})
}

function restorePromptForCurrentTab(): void {
	const tab = client.currentTab()
	if (!tab) {
		prompt.clear()
		return
	}
	const saved = promptStates.get(tab.sessionId)
	if (saved) {
		prompt.restoreState(saved)
		return
	}
	prompt.setHistory(client.getInputHistory())
	prompt.setText(client.getInputDraft())
	restorePromptEditForTab(tab)
}

function installPromptTabSwitchHandler(): void {
	client.setOnTabSwitch((fromSession, _toSession) => {
		render.enterFullscreen()
		promptStates.set(fromSession, prompt.snapshotState())
		saveCurrentPromptDraft(fromSession)
		restorePromptForCurrentTab()
		})
}

// App-level keybindings (not handled by prompt)
function handleAppKey(k: KeyEvent): boolean {
	if (handlePromptEditKey(k, promptInputWidth())) return true
	if (plainKey(k, 'up') && beginPreviousPromptEdit()) return true
	if (k.key === 'm' && !k.cmd && ((k.ctrl && !k.alt) || (k.alt && !k.ctrl))) {
		completion.dismiss()
		const currentModel = client.currentTab()?.model || models.defaultModel()
		popup.openModelPicker(chooseModelWithoutClearingDraft, currentModel)
		draw()
		return true
	}
	if (k.ctrl && !k.alt && !k.cmd) {
		// Ctrl-R: restart
		if (k.key === 'r') {
			restarting = true
			render.clearFrame()
			cleanupTerminal()
			process.exit(RESTART_CODE)
		}
		// Ctrl-C: quit
		if (k.key === 'c') exitCli(0)
		// Ctrl-D: quit if prompt empty, else let prompt handle (delete forward)
		if (k.key === 'd' && !prompt.text()) exitCli(0)
		// Ctrl-Z: suspend (SIGSTOP to process group, like a normal unix program)
		if (k.key === 'z') {
			suspend()
			return true
		}
		// Ctrl-L: force redraw
		if (k.key === 'l') {
			draw(true)
			return true
		}
		if (k.key === 'g') { blocks.outputPad = +!blocks.outputPad; render.invalidateHistoryCache(); draw(); return true }
		// Ctrl-T: new tab. Ctrl-Shift-T restores the most recently closed tab,
		// matching Chrome, so plain Ctrl-T must require no shift.
		if (k.key === 't') {
			sendTabCommand(k.shift ? 'resume' : 'open')
			return true
		}
		// Ctrl-F: fork tab
		if (k.key === 'f') {
			const tab = client.currentTab()
			if (tab) {
				client.saveDraft(prompt.draftText(), tab.sessionId, promptEditDraftFor(tab.sessionId))
				sendTabCommand('open', `fork:${tab.sessionId}`)
			}
			return true
		}
		// Ctrl-W: close tab
		if (k.key === 'w') {
			if (client.state.tabs.length > 1) client.sendCommand('close')
			return true
		}
		// Ctrl-N / Ctrl-P: tab switching
		if (k.key === 'n') {
			client.nextTab()
			return true
		}
		if (k.key === 'p') {
			client.prevTab()
			return true
		}
	}
	if (k.key === 'q' && k.ctrl && !k.alt && !k.cmd) {
		client.sendCommand('run-next-from-queue')
		draw()
		return true
	}
	// Opt-1 through Opt-9: jump to tab N, Opt-0: tab 10
	if (k.alt && k.key >= '0' && k.key <= '9') {
		client.switchTab(k.key === '0' ? 9 : Number(k.key) - 1)
		return true
	}
	// Escape: abort current generation if working
	if (k.key === 'escape' && client.isWorking()) {
		client.sendCommand('abort')
		return true
	}
	// Alt-Enter queues the prompt for later instead of steering the working turn.
	if (k.key === 'enter' && k.alt && !k.shift && !k.ctrl && !k.cmd) {
		submit(undefined, true)
		draw()
		return true
	}
	// Enter: continue a paused/error turn when the prompt is empty.
	// Otherwise submit the current prompt.
	if (k.key === 'enter' && !k.shift && !k.alt && !k.ctrl && !k.cmd) {
		if (!prompt.text().trim() && client.canContinueCurrentTurn()) {
			client.sendCommand('continue')
			draw()
			return true
		}
		submit()
		draw()
		return true
	}
	return false
}

function handleQuestionKey(k: KeyEvent): boolean {
	if (!terminalQuestions.activeQuestion()) return false
	// Existing app shortcuts retain priority; only prompt-specific Alt-Enter stays
	// with the inline editor. Unhandled input is then contained by the question.
	if ((k.ctrl || k.alt || k.cmd) && !(k.key === 'enter' && k.alt) && handleAppKey(k)) return true
	return terminalQuestions.handleKey(k)
}

// Terminal input passes through three ordered layers: emergency controls first,
// then stateful ANSI/paste parsing, then ordinary structured-key dispatch. The
// first layer must remain usable even when the second layer is waiting for input.
function handleInput(text: string): void {
	const emergency = keys.emergencyKey(text)
	if (emergency) {
		if (emergency.index > 0) handleInput(text.slice(0, emergency.index))
		if (emergency.key.key === 'z') keys.state.pasteUpdatedAt = 0
		handleAppKey(emergency.key)
		return
	}
	for (const k of keys.parseKeys(text)) {
		// Popup keys first — an active modal owns the keyboard.
		if (popup.state.active && popup.handleKey(k)) {
			draw()
			continue
		}
		// Active questions contain ordinary input, while existing app shortcuts
		// such as Ctrl-N/P still run through their native handler.
		if (handleQuestionKey(k)) {
			draw()
			continue
