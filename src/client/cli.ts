// CLI -- terminal input handling. See docs/terminal.md for rules.
// Thin layer: parses keys, dispatches to prompt or app keybindings.

import { client } from '../client.ts'
import { render } from './render.ts'
import { cursor } from '../cli/cursor.ts'
import { keys } from '../cli/keys.ts'
import { prompt } from '../cli/prompt.ts'
import { completion } from '../cli/completion.ts'
import { helpBar } from '../cli/help-bar.ts'
import { popup } from './popup.ts'
import { clipboard } from '../cli/clipboard.ts'
import { blocks } from '../cli/blocks.ts'
import { perf } from '../perf.ts'
import { openaiUsage } from '../openai-usage.ts'
import type { KeyEvent } from '../cli/keys.ts'

const RESTART_CODE = 100

// Kitty keyboard protocol: tell terminal to send all keys (including Cmd+C/X/V)
// to the app instead of intercepting them. Mode 19 = disambiguate(1) +
// report events(2) + report all keys as escapes(16).
const KITTY_TERMS = /^(kitty|ghostty|iTerm\.app)$/
const useKitty = KITTY_TERMS.test(process.env.TERM_PROGRAM ?? '')
const KITTY_ON = '\x1b[>19u'
const KITTY_OFF = '\x1b[<u'
const BRACKETED_PASTE_ON = '\x1b[?2004h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'

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

function writeTabStops(cols: number, step: number): void {
	let seq = '\x1b[3g'
	for (let c = step + 1; c <= cols; c += step) seq += `\x1b[${c}G\x1bH`
	seq += '\x1b[1G'
	process.stdout.write(seq)
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

function draw(force = false): void {
	if (force) {
		// Force paints are user-triggered — execute immediately.
		// Cancel any pending throttled paint so we don't double-draw.
		if (paintTimer) {
			clearTimeout(paintTimer)
			paintTimer = null
		}
		paintQueued = false
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
	// Flush any buffered perf marks before the final repaint. Without this,
	// fast exits can drop startup telemetry because the 100ms sink timer has
	// not fired yet.
	perf.stop()
	// Preserve the last fully up-to-date frame for copy/paste on exit.
	draw(true)
	cleanupTerminal()
	process.stdout.write('\r\n')
	process.exit(code)
}

let terminalCleaned = false

// Restore terminal state and save client state before exiting.
// Must be called on ALL exit paths. The guard prevents double-cleanup
// when process.on('exit') fires after an explicit cleanupTerminal() call.
function cleanupTerminal(): void {
	if (terminalCleaned) return
	terminalCleaned = true
	cursor.stop()
	// Persist the current draft so it survives restart
	client.saveDraft(prompt.draftText())
	client.saveState()
	if (useKitty) process.stdout.write(KITTY_OFF)
	process.stdout.write(BRACKETED_PASTE_OFF)
	writeTabStops(process.stdout.columns || 80, 8)
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
}

let suspended = false

// Suspend the process (ctrl-z). Restores terminal to normal state, then
// sends SIGSTOP to the process group (or just this pid as fallback).
// The shell will show its prompt. `fg` resumes us and triggers SIGCONT.
function suspend(): void {
	suspended = true
	process.stdout.write(`${useKitty ? KITTY_OFF : ''}\x1b[?25h`)
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
	if (useKitty) process.stdout.write(KITTY_ON)
	process.stdout.write(BRACKETED_PASTE_ON)
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

const rawState = {
	active: false,
	pending: [] as string[],
	flushTimer: null as ReturnType<typeof setTimeout> | null,
}

function flushRawTokens(emit = (text: string) => client.addEntry(text)): void {
	if (rawState.flushTimer) {
		clearTimeout(rawState.flushTimer)
		rawState.flushTimer = null
	}
	if (rawState.pending.length === 0) return
	emit(rawState.pending.join(' '))
	rawState.pending = []
}

function quoteRawChar(ch: string): string {
	if (ch === '\\') return "'\\\\'"
	if (ch === "'") return "'\\\''"
	return `'${ch}'`
}

function formatRawToken(token: string): string {
	const bytes = [...Buffer.from(token)]
	if (bytes.length === 1 && bytes[0]! >= 0x20 && bytes[0]! <= 0x7e) return quoteRawChar(String.fromCharCode(bytes[0]!))
	return `[${bytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(' ')}]`
}

function startRawMode(emit = (text: string) => client.addEntry(text)): void {
	if (rawState.active) {
		emit('Raw input mode is already on.')
		return
	}
	rawState.active = true
	rawState.pending = []
	emit('Raw input mode on. Press Esc to exit.')
}

function stopRawMode(emit = (text: string) => client.addEntry(text)): void {
	flushRawTokens(emit)
	if (!rawState.active) return
	rawState.active = false
	emit('Raw input mode off.')
}

function handleRawInput(data: string, emit = (text: string) => client.addEntry(text)): boolean {
	if (!rawState.active) return false
	for (const token of keys.splitKeys(data)) {
		const key = keys.parseKey(token)
		if (key?.key === 'escape' && !key.alt && !key.ctrl && !key.cmd) {
			stopRawMode(emit)
			continue
		}
		rawState.pending.push(formatRawToken(token))
	}
	if (rawState.pending.length > 0 && !rawState.flushTimer) {
		rawState.flushTimer = setTimeout(() => flushRawTokens(emit), 50)
	}
	return true
}


function resetRawModeForTests(): void {
	flushRawTokens(() => {})
	rawState.active = false
	rawState.pending = []
}

function submit(override?: string): void {
	const text = (override ?? prompt.text()).trim()
	if (!text) return
	completion.dismiss()
	popup.close()
	// Push to prompt module for immediate up-arrow recall
	prompt.pushHistory(text)
	if (text === '/raw') {
		startRawMode()
		prompt.clear()
		client.onSubmit(text)
		draw()
		return
	}
	// Human typing now uses the same prompt command path as inbox messages.
	// The runtime decides whether an active turn makes this behave like steering.
	client.sendCommand('prompt', text)
	prompt.clear()
	// Update tab's inputHistory + clear persisted draft
	client.onSubmit(text)
}

// ── Tab completion key handling ──────────────────────────────────────────────
// Tab triggers completion. While popup is active:
//   Tab / Down: cycle forward
//   Shift-Tab / Up: cycle backward
//   Enter / Space: accept selected item
//   Escape: dismiss

function handleCompletionKey(k: KeyEvent): boolean {
	// Tab triggers or cycles completion
	if (k.key === 'tab' && !k.ctrl && !k.alt && !k.cmd) {
		if (!completion.state.active) {
			// Trigger new completion
			const result = completion.complete(prompt.text(), prompt.cursorPos())
			if (!result || result.items.length === 0) return false
			completion.state.active = true
			completion.state.lastResult = result
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

	// Only handle remaining keys when popup is active
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

// Canonical key name for help bar usage tracking
function canonicalKeyName(k: KeyEvent): string {
	const parts: string[] = []
	if (k.ctrl) parts.push('ctrl')
	if (k.alt) parts.push('alt')
	if (k.shift) parts.push('shift')
	if (k.cmd) parts.push('cmd')
	parts.push(k.key || k.char || '?')
	return parts.join('-')
}

function sendTabCommandIfRoom(type: 'open' | 'resume', text?: string): void {
	if (client.state.tabs.length < 40) client.sendCommand(type, text)
	else client.addEntry('Max tabs reached (40). Close one first.', 'error')
}

// App-level keybindings (not handled by prompt)
function handleAppKey(k: KeyEvent): boolean {
	if (k.key === 'm' && !k.cmd && ((k.ctrl && !k.alt) || (k.alt && !k.ctrl))) {
		completion.dismiss()
		const currentModel = client.currentTab()?.model || client.state.model || undefined
		popup.openModelPicker((model) => {
			submit(`/model ${model}`)
			openaiUsage.noteActivity()
			draw()
		}, currentModel)
		draw()
		return true
	}
	if (k.ctrl && !k.alt && !k.cmd) {
		// Ctrl-R: restart
		if (k.key === 'r') {
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
			sendTabCommandIfRoom(k.shift ? 'resume' : 'open')
			return true
		}
		// Ctrl-F: fork tab
		if (k.key === 'f') {
			const tab = client.currentTab()
			if (tab) sendTabCommandIfRoom('open', `fork:${tab.sessionId}`)
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
	// Opt-1 through Opt-9: jump to tab N, Opt-0: tab 10
	if (k.alt && k.key >= '0' && k.key <= '9') {
		client.switchTab(k.key === '0' ? 9 : Number(k.key) - 1)
		return true
	}
	// Escape: abort current generation if busy
	if (k.key === 'escape' && client.isBusy()) {
		client.sendCommand('abort')
		return true
	}
	// Enter: continue a paused/error turn when the prompt is empty.
	// Otherwise submit the current prompt (blocked while image paste resolves).
	if (k.key === 'enter' && !k.shift) {
		if (clipboard.hasPendingPastes()) return true
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

function startCli(signal: AbortSignal): void {
	// Wire state changes to repaint.
	client.setOnChange(draw)

	// Wire prompt to trigger repaint on async paste resolve.
	prompt.setRenderCallback(() => {
		openaiUsage.noteActivity()
		draw()
	})

	client.startClient(signal)

	// Initialize prompt history and draft from the active tab.
	// (Tab switch handler takes care of swapping these later.)
	prompt.setHistory(client.getInputHistory())
	const savedDraft = client.getInputDraft()
	if (savedDraft) prompt.setText(savedDraft)

	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
		if (useKitty) process.stdout.write(KITTY_ON)
		process.stdout.write(BRACKETED_PASTE_ON)
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
	process.stdout.on('resize', () => {
		writeTabStops(process.stdout.columns || 80, blocks.config.tabWidth)
		draw(true)
	})

	perf.mark('Ready for input')

	// Wire draft save/restore on tab switch.
	// Persists to disk so drafts survive restarts and multi-client setups.
	// Also swap prompt history so up-arrow recalls per-tab entries.
	client.setOnTabSwitch((fromSession, _toSession) => {
		// Save outgoing tab's draft (uses draftText so we save the
		// user's composition, not a history entry they're browsing).
		// Pass fromSession because activeTab has already changed.
		client.saveDraft(prompt.draftText(), fromSession)
		// Load incoming tab's draft and history
		prompt.setText(client.getInputDraft())
		prompt.setHistory(client.getInputHistory())
		openaiUsage.noteActivity()
	})

	// When another client saves a draft for our active tab and our
	// prompt is empty, show it. This is how "client A quits with a
	// draft on tab 10, client B picks it up" works.
	client.setOnDraftArrived((text) => {
		if (!prompt.text() && text) {
			prompt.setText(text)
			openaiUsage.noteActivity()
			draw()
		}
	})

	process.stdin.on('data', (data: Buffer) => {
		const text = data.toString('utf-8')
		if (handleRawInput(text)) {
			draw()
			return
		}
		for (const k of keys.parseKeys(text)) {
			// Track key usage for help bar
			if (k.ctrl || k.alt || k.cmd || k.key === 'enter' || k.key === 'escape' || k.key === 'tab') {
				helpBar.logKey(canonicalKeyName(k))
			}
			// Popup keys first — an active modal owns the keyboard.
			if (popup.state.active && popup.handleKey(k)) {
				openaiUsage.noteActivity()
				draw()
				continue
			}
			// Completion keys next (tab, arrows in popup, etc.)
			if (handleCompletionKey(k)) {
				openaiUsage.noteActivity()
				draw()
				continue
			}
			// App keybindings
			if (handleAppKey(k)) continue
			// Then prompt editing
			if (prompt.handleKey(k, process.stdout.columns || 80)) {
				openaiUsage.noteActivity()
				draw()
			}
		}
	})
	process.stdin.on('end', handleStdinClosed)
	process.stdin.on('close', handleStdinClosed)
}


export const cli = {
	startCli,
	formatRawToken,
	forTests: {
		handleAppKey,
	},
	rawModeForTests: {
		start: startRawMode,
		stop: stopRawMode,
		handle: handleRawInput,
		flush: flushRawTokens,
		active: () => rawState.active,
		reset: resetRawModeForTests,
	},
}
