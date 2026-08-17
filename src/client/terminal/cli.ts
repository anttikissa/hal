// CLI -- terminal input handling. See docs/terminal.md for rules.
// Thin layer: parses keys, dispatches to prompt or app keybindings.

import { readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { client } from '../app.ts'
import { render } from './render.ts'
import { renderStatus } from './render-status.ts'
import { cursor } from './cursor.ts'
import { keys } from './keys.ts'
import { prompt, type PromptEditorState } from './prompt.ts'
import { completion } from './completion.ts'
import { completionHints } from './completion-hints.ts'
import { clientLocalCommands } from '../local-commands.ts'
import { popup } from './popup.ts'
import { blocks } from './blocks.ts'
import { colors } from './colors.ts'
import { perf } from '../perf.ts'
import { clientBackend } from '../backend.ts'
import { models } from '../../common/models.ts'
import { clientTransport } from '../transport.ts'
import type { KeyEvent } from './keys.ts'
import { time } from '../../utils/time.ts'
import { terminalOutput } from './terminal-output.ts'
import { promptEdit } from '../prompt-edit.ts'
import type { DraftPromptEdit } from '../draft.ts'

const RESTART_CODE = 100

// Kitty keyboard protocol: tell terminal to send all keys (including Cmd+C/X/V)
// to the app instead of intercepting them. Mode 17 = disambiguate(1) +
// report all keys as escapes(16). Do NOT enable report events(2): in Ghostty,
// Cmd-C while selecting scrollback sends only a key-release event to the pty,
// and any pty input snaps scrollback to the bottom and clears the selection.
const KITTY_TERMS = /^(kitty|ghostty|iTerm\.app)$/
const useKitty = KITTY_TERMS.test(process.env.TERM_PROGRAM ?? '')
const KITTY_ON = '\x1b[>17u'
const KITTY_OFF = '\x1b[<u'
const BRACKETED_PASTE_ON = '\x1b[?2004h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'
const CURSOR_SHAPE_DEFAULT = '\x1b[0 q'
const CURSOR_COLOR_DEFAULT = '\x1b]112\x07'

// Set hardware tab stops every N columns via HTS (ESC H).
// Terminals default to 8-wide tabs. We set 4 so tab chars render
// at 4-wide stops and can be copied as real tabs.
//
// Procedure:
//   1. ESC[3g — clear all existing tab stops
//   2. For each stop: CSI {col}G to move there, then ESC H to set it
//   3. CSI 1G — move cursor back to column 1
//
// CSI G columns are 1-based. For 4-wide tabs the stops are at
// columns 5, 9, 13, 17, ... (i.e. positions where the cursor lands
// after pressing tab at columns 1–4, 5–8, etc.)

function writeTabStops(cols: number, step: number, opts: { bypassExternalEditorLatch?: boolean } = {}): void {
	let seq = '\x1b[3g'
	for (let c = step + 1; c <= cols; c += step) seq += `\x1b[${c}G\x1bH`
	seq += '\x1b[1G'
	terminalOutput.write(seq, opts)
}

// ── Paint throttle ───────────────────────────────────────────────────────────
// During streaming, every token fires onChange → draw(). Without throttling,
// this saturates the event loop with synchronous frame builds and stdout
// writes, starving stdin — keypresses don't register while the assistant
// is typing. Fix: coalesce non-force draws into at most one per PAINT_INTERVAL.
// Force draws (tab switch, resize, Ctrl-L) always execute immediately.
const PAINT_INTERVAL = 16 // ms — ~60 fps, plenty for streaming text
let paintTimer: ReturnType<typeof setTimeout> | null = null
let paintQueued = false
let promptStates = new Map<string, PromptEditorState>()

function clearPendingPaint(): void {
	if (paintTimer) {
		clearTimeout(paintTimer)
		paintTimer = null
	}
	paintQueued = false
}

function draw(force = false): void {
	if (terminalOutput.isExternalEditorOpen()) return
	if (force) {
		// Force paints are user-triggered — execute immediately.
		// Cancel any pending throttled paint so we don't double-draw.
		clearPendingPaint()
		render.draw(true)
		return
	}
	// Non-force: coalesce. If a timer is already ticking, just note that
	// another paint was requested. The timer callback will pick it up.
	if (paintTimer) {
		paintQueued = true
		return
	}
	// No timer running — paint now, then start the cooldown.
	render.draw(false)
	paintTimer = setTimeout(() => {
		paintTimer = null
		if (paintQueued) {
			paintQueued = false
			render.draw(false)
		}
	}, PAINT_INTERVAL)
}

function exitCli(code: number): void {
	// Leave the submitted input visible, then start the shell at the status row.
	draw(true)
	const p = prompt.buildPrompt(promptInputWidth())
	// Move cursor to just below the prompt (p.lines.length - p.cursor.rowOffset)
	// plus one line so that the prompt bottom bar also stays visible (+ 1).
	// Change to +2 if you want to leave the status row too.
	terminalOutput.write(`\x1b[${p.lines.length - p.cursor.rowOffset + 1}B\r\x1b[J`)
	cleanupTerminal()
	process.exit(code)
}

let terminalCleaned = false
function promptEditDraftFor(sessionId?: string | null): DraftPromptEdit | undefined {
	const active = promptEdit.activeFor(sessionId)
	if (!active) return undefined
	return {
		mode: active.mode,
		originalText: active.originalText,
		pausedWorkingTurn: active.pausedWorkingTurn,
	}
}

function saveCurrentPromptDraft(sessionId?: string): void {
	const sid = sessionId ?? client.currentTab()?.sessionId
	if (!sid) return
	client.saveDraft(prompt.draftText(), sid, promptEditDraftFor(sid))
}
let restarting = false

// Restore terminal state and save client state before exiting.
// Must be called on ALL exit paths. The guard prevents double-cleanup
// when process.on('exit') fires after an explicit cleanupTerminal() call.
function cleanupTerminal(): void {
	if (terminalCleaned) return
	terminalCleaned = true
	const bypass = { bypassExternalEditorLatch: true }
	cursor.stop()
	// Persist the current draft so it survives restart
	saveCurrentPromptDraft()
	client.saveState({ restart: restarting })
	if (useKitty) terminalOutput.write(KITTY_OFF, bypass)
	terminalOutput.write(BRACKETED_PASTE_OFF + CURSOR_SHAPE_DEFAULT + CURSOR_COLOR_DEFAULT, bypass)
	writeTabStops(process.stdout.columns || 80, 8, bypass)
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
}

let suspended = false

// Suspend the process (ctrl-z). Restores terminal to normal state, then
// sends SIGSTOP to the process group (or just this pid as fallback).
// The shell will show its prompt. `fg` resumes us and triggers SIGCONT.
function suspend(): void {
	suspended = true
	terminalOutput.write(`${useKitty ? KITTY_OFF : ''}${CURSOR_SHAPE_DEFAULT}${CURSOR_COLOR_DEFAULT}\x1b[?25h`)
	// process.kill(0, ...) sends to the entire process group — this is
	// the standard way for a foreground job to suspend itself.
	try { process.kill(0, 'SIGSTOP') } catch { process.kill(process.pid, 'SIGSTOP') }
}

// Called when the shell resumes us with `fg`. Re-initialize terminal state.
function onSigcont(): void {
	if (!suspended) return
	suspended = false
	if (process.stdin.isTTY) {
		// Toggle raw mode off/on to reset the tty driver
		process.stdin.setRawMode(false)
		process.stdin.setRawMode(true)
		process.stdin.setEncoding('utf8')
		process.stdin.resume()
	}
	if (useKitty) terminalOutput.write(KITTY_ON)
	terminalOutput.write(BRACKETED_PASTE_ON)
	writeTabStops(process.stdout.columns || 80, blocks.config.tabWidth)
	draw(true)
}

function handleResize(): void {
	if (terminalOutput.isExternalEditorOpen()) return
	writeTabStops(process.stdout.columns || 80, blocks.config.tabWidth)
	draw(true)
}

function handleStdinClosed(): void {
	// Non-interactive callers (tests, scripts, editor integrations) often pipe
	// stdin to Hal. If that pipe closes, there is nobody left to drive the UI,
	// so keeping timers, file watchers and host-election polling alive only leaks
	// an orphaned background process. TTY users do not hit this path.
	if (process.stdin.isTTY) return
	exitCli(0)
}

function isAnthropicModel(model: string): boolean {
	const full = models.resolveModel(model)
	return models.providerName(full).toLowerCase() === 'anthropic'
}

function lastAnthropicAssistantAt(tab: (typeof client.state.tabs)[number]): number | null {
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]
		if (!block || block.type !== 'assistant' || !block.ts) continue
		if (!isAnthropicModel(block.model ?? tab.model)) continue
		return block.ts
	}
	return null
}

function claudeCacheWarning(tab: (typeof client.state.tabs)[number] | null, text: string, now = Date.now()): { contextTokens: number; thresholdTokens: number; ageText: string } | null {
	if (!client.config.claudeCacheWarningEnabled) return null
	if (!tab) return null
	if (!text.trim() || text.trim().startsWith('/')) return null
	if (!isAnthropicModel(tab.model)) return null

	const contextTokens = Math.max(0, Math.round(tab.contextUsed ?? 0))
	const thresholdTokens = Math.max(1, Math.round(client.config.claudeCacheWarningTokensPerFiveHourPercent * client.config.claudeCacheWarningQuotaPercent))
	if (contextTokens < thresholdTokens) return null

	const lastAt = lastAnthropicAssistantAt(tab)
	if (lastAt && now - lastAt < client.config.claudeCacheWarningStaleMs) return null

	const ageText = lastAt ? time.formatShortAge(now - lastAt) : 'no previous Claude turn in this tab'
	return { contextTokens, thresholdTokens, ageText }
}

function openClaudeCacheWarning(text: string, displayText: string | undefined, warning: NonNullable<ReturnType<typeof claudeCacheWarning>>, queue?: boolean): void {
	popup.openConfirm(
		'Claude cache likely cold',
		[
			`Sending this may write ~${models.formatTokenCount(warning.contextTokens)} tokens to Anthropic prompt cache.`,
			`Warning threshold: ~${models.formatTokenCount(warning.thresholdTokens)} tokens, roughly ${client.config.claudeCacheWarningQuotaPercent}% of 5h quota at current estimate.`,
			`Last Claude turn: ${warning.ageText}.`,
		],
		['Send anyway', 'Switch to GPT', 'Cancel'],
		(choice) => {
			if (choice === 'Send anyway') submitPromptText(text, displayText, queue)
			if (choice === 'Switch to GPT') client.sendCommand('prompt', '/model gpt')
			draw()
		},
	)
}

function openToolConfirm(event: any): void {
	const body = Array.isArray(event.body) ? event.body.map(String) : ['This tool call looks risky.']
	popup.openConfirm(
		event.title ?? 'Risky tool call',
		body,
		['Yes', 'No'],
		(choice) => {
			client.clearToolConfirmPending(event.sessionId)
			clientTransport.io.appendCommand({ type: 'tool-confirm', sessionId: event.sessionId, requestId: String(event.requestId), approved: choice === 'Yes' })
			draw()
		},
		'danger',
	)
	draw()
}

function rebaseRequestId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

async function runExternalEditor(path: string): Promise<number> {
	const editor = process.env.EDITOR || process.env.VISUAL || 'vim'
	const wasTty = process.stdin.isTTY
	clearPendingPaint()
	// Clear Hal's frame before handing the terminal to the editor. The latch is
	// enabled immediately after this, so later Hal paints are dropped while the
	// editor owns stdout.
	render.clearFrame()
	terminalOutput.setExternalEditorOpen(true)
	process.stdin.pause()
	cleanupTerminal()
	await terminalOutput.flush()
	try {
		const proc = Bun.spawn(['sh', '-c', `${editor} "$1"`, 'hal-editor', path], {
			stdin: 'inherit',
			stdout: 'inherit',
			stderr: 'inherit',
		})
		return await proc.exited
	} finally {
		terminalOutput.setExternalEditorOpen(false)
		terminalCleaned = false
		if (wasTty) {
			process.stdin.setRawMode(true)
			process.stdin.setEncoding('utf8')
			process.stdin.resume()
			if (useKitty) terminalOutput.write(KITTY_ON)
			terminalOutput.write(BRACKETED_PASTE_ON)
			writeTabStops(process.stdout.columns || 80, blocks.config.tabWidth)
		} else {
			process.stdin.resume()
		}
		cursor.start(() => {
			if (!render.hasAnimatedIndicators()) return
			draw()
		})
		draw(true)
	}
}

async function openRebaseEditor(event: any): Promise<void> {
	const path = `${tmpdir()}/hal-rebase-${event.sessionId}-${event.requestId}.txt`
	writeFileSync(path, String(event.todo ?? ''))
	const code = await runExternalEditor(path)
	if (code !== 0) {
		client.addEntry(`Rebase editor exited with code ${code}`, 'error')
		return
	}
	const todo = readFileSync(path, 'utf-8')
	const edits: Record<string, string> = {}
	for (const line of todo.split('\n')) {
		const match = line.match(/^edit\s+(\S+)\s+/)
		if (!match) continue
		const id = match[1]!
		const rowText = event.editTexts?.[id]
		if (typeof rowText !== 'string') continue
		const editPath = `${tmpdir()}/hal-rebase-${event.sessionId}-${event.requestId}-${id}.txt`
		writeFileSync(editPath, rowText)
		const editCode = await runExternalEditor(editPath)
		if (editCode !== 0) {
			client.addEntry(`Rebase edit editor exited with code ${editCode}`, 'error')
			return
		}
		edits[id] = readFileSync(editPath, 'utf-8')
	}
	client.sendCommand('rebase-apply', JSON.stringify({ todo, edits }), String(event.requestId ?? ''))
}

function handleRebaseStart(event: any): void {
	void openRebaseEditor(event)
}

function handleRebaseResult(event: any): void {
	if (event.ok) {
		if (event.unchanged) client.addEntry('Rebase unchanged.')
		else if (event.aborted) client.addEntry('Rebase aborted.')
		else client.addEntry(`Rebased to ${event.newLog}${event.queued ? `; queued ${event.queued}` : ''}.`)
		draw(true)
		return
	}
	const errors = Array.isArray(event.errors) ? event.errors.map(String) : ['Rebase failed']
	if (event.todo) {
		void openRebaseEditor({ ...event, todo: `${errors.map((err: string) => `# ${err}`).join('\n')}\n${event.todo}` })
		return
	}
	client.addEntry(errors.join('\n'), 'error')
	draw(true)
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
	const displayText = prompt.text().trim()
	if (!text) return
	if (active.mode === 'amend' || active.mode === 'cancel') {
		prompt.pushHistory(text)
		promptEdit.cancel()
		client.sendCommand('prompt-amend', text, displayText === text ? undefined : displayText)
		prompt.clear()
		clearSavedPromptState()
		client.onSubmit(text)
		return
	}
	promptEdit.cancel()
	submit(text, queue)
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
	if (plainKey(k, 'down') && !prompt.isBrowsingHistory() && prompt.atVerticalBoundary(1, contentWidth)) {
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

function submitPromptText(text: string, displayText: string | undefined, queue?: boolean): void {
	completion.dismiss()
	popup.close()
	promptEdit.cancel()
	// Push to prompt module for immediate up-arrow recall
	prompt.pushHistory(text)
	// Human typing now uses the same prompt command path as inbox messages.
	// The runtime decides whether an working turn makes this behave like steering.
	client.sendCommand('prompt', text, displayText === text ? undefined : displayText, queue)
	prompt.clear()
	clearSavedPromptState()
	// Update tab's inputHistory + clear persisted draft
	client.onSubmit(text)
}

function handleLocalCommand(text: string): boolean {
	if (text === '/rebase') {
		prompt.pushHistory(text)
		client.sendCommand('rebase-start', rebaseRequestId())
		prompt.clear()
		clearSavedPromptState()
		client.onSubmit(text)
		return true
	}

	const parsed = clientLocalCommands.parse(text)
	if (!parsed) return false
	if (!clientLocalCommands.commandNames().includes(parsed.name)) return false

	prompt.pushHistory(text)
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
	if (result.error) client.addEntry(result.error, 'error', false)
	if (result.quit) exitCli(0)
	return true
}

function submit(override?: string, queue?: boolean): void {
	const text = (override ?? prompt.submitText()).trim()
	const displayText = override === undefined ? prompt.text().trim() : undefined
	if (!text) return
	if (handleLocalCommand(text)) return
	const warning = override === undefined ? claudeCacheWarning(client.currentTab(), text) : null
	if (warning) {
		completion.dismiss()
		openClaudeCacheWarning(text, displayText, warning, queue)
		return
	}
	submitPromptText(text, displayText, queue)
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

function handleCompletionKey(k: KeyEvent): boolean {
	// Tab triggers or cycles completion
	if (k.key === 'tab' && !k.ctrl && !k.alt && !k.cmd) {
		if (!completion.state.active) {
			// Trigger new completion
			const result = completion.complete(prompt.text(), prompt.cursorPos(), client.currentTab()?.cwd)
			if (!result || result.items.length === 0) return false
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
	clientBackend.subscriptions.noteActivity()
	draw()
}

function promptInputWidth(): number {
	return renderStatus.promptContentWidth(process.stdout.columns || 80)
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
		promptStates.set(fromSession, prompt.snapshotState())
		saveCurrentPromptDraft(fromSession)
		restorePromptForCurrentTab()
		clientBackend.subscriptions.noteActivity()
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

function startCli(signal: AbortSignal, opts: { preferredSessionId?: string; openCwd?: string } = {}): void {
	// Wire state changes to repaint.
	client.setOnChange(draw)
	client.setOnToolConfirmRequest(openToolConfirm)
	client.setOnRebaseStart(handleRebaseStart)
	client.setOnRebaseResult(handleRebaseResult)
	colors.onChange(() => {
		render.invalidateHistoryCache()
		draw()
	})

	// Wire prompt to trigger repaint on async paste resolve.
	prompt.setRenderCallback(() => {
		clientBackend.subscriptions.noteActivity()
		draw()
	})

	client.startClient(signal, { ...opts, viewportCols: process.stdout.columns || 80 })

	// Initialize prompt history and draft from the focused tab.
	// (Tab switch handler takes care of swapping these later.)
	restorePromptForCurrentTab()

	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		// Decode bytes as UTF-8 so multi-byte sequences (e.g. box-drawing chars)
		// that span chunk boundaries don't get mangled into U+FFFD. Node's stream
		// uses an internal StringDecoder that buffers partial sequences.
		process.stdin.setEncoding('utf8')
		process.stdin.resume()
		if (useKitty) terminalOutput.write(KITTY_ON)
		terminalOutput.write(BRACKETED_PASTE_ON)
		writeTabStops(process.stdout.columns || 80, blocks.config.tabWidth)
	}
	else {
		// Pipe-backed stdin stays paused unless we resume it. Without this, EOF from
		// a dead parent test runner/editor never reaches our end/close handlers.
		process.stdin.resume()
	}
	// Safety net: if we exit without hitting an explicit cleanup path
	// (e.g. SIGTERM, uncaught exception), this still restores the terminal.
	process.on('exit', cleanupTerminal)
	process.on('SIGCONT', onSigcont)

	// Keep pulsing indicators in sync with the shared 500ms clock. We only redraw
	// when some tab actually has an animated indicator, so idle terminals stay quiet.
	cursor.start(() => {
		if (!render.hasAnimatedIndicators()) return
		draw()
	})

	perf.mark('First draw')
	draw()
	perf.mark('First draw done')
	process.stdout.on('resize', handleResize)
	process.on('SIGWINCH', handleResize)
	signal.addEventListener('abort', () => {
		process.stdout.off('resize', handleResize)
		process.off('SIGWINCH', handleResize)
	}, { once: true })

	perf.mark('Ready for input')

	// Wire draft save/restore on tab switch.
	// Persists to disk so drafts survive restarts and multi-client setups.
	// Also swap prompt history so up-arrow recalls per-tab entries.
	installPromptTabSwitchHandler()

	// When another client saves a draft for our focused tab and our
	// prompt is empty, show it. This is how "client A quits with a
	// draft on tab 10, client B picks it up" works.
	client.setOnDraftArrived((text, savedEdit) => {
		if (!prompt.text() && (text || savedEdit)) {
			prompt.setText(text)
			const tab = client.currentTab()
			if (tab) tab.inputDraftEdit = savedEdit
			if (tab) restorePromptEditForTab(tab)
			clientBackend.subscriptions.noteActivity()
			draw()
		}
	})

	process.stdin.on('data', (data: Buffer | string) => {
		// stdin.setEncoding('utf8') makes data a string with multi-byte sequences
		// already buffered across chunk boundaries. Pipe-backed stdin (no TTY)
		// may still deliver Buffers, so coerce defensively.
		const text = typeof data === 'string' ? data : data.toString('utf-8')
		for (const k of keys.parseKeys(text)) {
			// Popup keys first — an active modal owns the keyboard.
			if (popup.state.active && popup.handleKey(k)) {
				clientBackend.subscriptions.noteActivity()
				draw()
				continue
			}
			// Completion keys next (tab, arrows in popup, etc.)
			if (handleCompletionKey(k)) {
				clientBackend.subscriptions.noteActivity()
				draw()
				continue
			}
			// App keybindings
			if (handleAppKey(k)) continue
			// Then prompt editing
			if (prompt.handleKey(k, promptInputWidth())) {
				client.clearRestoreTabHint()
				clientBackend.subscriptions.noteActivity()
				draw()
			}
		}
	})
	process.stdin.on('end', handleStdinClosed)
	process.stdin.on('close', handleStdinClosed)
}


export const cli = {
	startCli,
	forTests: {
		handleAppKey,
		claudeCacheWarning,
		kittyOnSequence: () => KITTY_ON,
		installPromptTabSwitchHandler,
		restorePromptForCurrentTab,
		promptInputWidth,
		resetPromptStates: () => {
			promptStates = new Map<string, PromptEditorState>()
		},
		setExternalEditorOpen: (value: boolean) => {
			terminalOutput.setExternalEditorOpen(value)
			if (value) clearPendingPaint()
		},
	},
}
