// CLI -- terminal input handling. See docs/terminal.md for rules.
// Thin layer: parses keys, dispatches to prompt or app keybindings.

import { client } from '../client.ts'
import { render } from './render.ts'
import { keys } from '../cli/keys.ts'
import { prompt } from '../cli/prompt.ts'
import { completion } from '../cli/completion.ts'
import { helpBar } from '../cli/help-bar.ts'
import { clipboard } from '../cli/clipboard.ts'
import { perf } from '../perf.ts'
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

function draw(force = false): void {
	render.draw(force)
}

let terminalCleaned = false

// Restore terminal state and save client state before exiting.
// Must be called on ALL exit paths. The guard prevents double-cleanup
// when process.on('exit') fires after an explicit cleanupTerminal() call.
function cleanupTerminal(): void {
	if (terminalCleaned) return
	terminalCleaned = true
	client.saveState()
	if (useKitty) process.stdout.write(KITTY_OFF)
	process.stdout.write(BRACKETED_PASTE_OFF)
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
}

function submit(): void {
	const text = prompt.text().trim()
	if (!text) return
	completion.dismiss()
	// Push to both prompt module (for immediate up-arrow) and client
	// (so the tab's inputHistory persists across tab switches).
	prompt.pushHistory(text)
	client.appendInputHistory(text)
	// If the session is busy (generating/running tools), send a steer command
	// instead of a plain prompt. The server will abort the current generation,
	// inject this as a steering message, and restart generation.
	if (client.isBusy()) {
		client.sendCommand('steer', text)
	} else {
		client.sendCommand('prompt', text)
	}
	prompt.clear()
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

// App-level keybindings (not handled by prompt)
function handleAppKey(k: KeyEvent): boolean {
	// Ctrl-R: restart
	if (k.key === 'r' && k.ctrl) {
		render.clearFrame()
		cleanupTerminal()
		process.exit(RESTART_CODE)
	}
	// Ctrl-C: quit
	if (k.key === 'c' && k.ctrl) {
		cleanupTerminal()
		process.stdout.write('\r\n')
		process.exit(0)
	}
	// Ctrl-D: quit if prompt empty, else let prompt handle (delete forward)
	if (k.key === 'd' && k.ctrl && !prompt.text()) {
		cleanupTerminal()
		process.stdout.write('\r\n')
		process.exit(0)
	}
	// Ctrl-L: force redraw
	if (k.key === 'l' && k.ctrl) {
		draw(true)
		return true
	}
	// Ctrl-T: new tab
	if (k.key === 't' && k.ctrl) {
		if (client.state.tabs.length < 40) client.sendCommand('open')
		return true
	}
	// Ctrl-W: close tab
	if (k.key === 'w' && k.ctrl) {
		if (client.state.tabs.length > 1) client.sendCommand('close')
		return true
	}
	// Ctrl-N / Ctrl-P: tab switching
	if (k.key === 'n' && k.ctrl) {
		client.nextTab()
		return true
	}
	if (k.key === 'p' && k.ctrl) {
		client.prevTab()
		return true
	}
	// Opt-1 through Opt-9: jump to tab N, Opt-0: tab 10
	if (k.alt && k.key >= '0' && k.key <= '9') {
		client.switchTab(k.key === '0' ? 9 : Number(k.key) - 1)
		return true
	}
	// Enter: submit (blocked while image paste is resolving)
	if (k.key === 'enter' && !k.shift) {
		if (clipboard.hasPendingPastes()) return true
		submit()
		draw()
		return true
	}
	return false
}

function startCli(signal: AbortSignal): void {
	// Wire state changes to repaint.
	client.setOnChange((force) => draw(force))

	// Wire prompt to trigger repaint on async paste resolve.
	prompt.setRenderCallback(() => {
		syncPromptToClient()
		draw()
	})

	client.startClient(signal)

	// Initialize prompt history from the active tab's session history.
	// (Tab switch handler takes care of swapping it later.)
	prompt.setHistory(client.getInputHistory())

	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
		if (useKitty) process.stdout.write(KITTY_ON)
		process.stdout.write(BRACKETED_PASTE_ON)
	}
	// Safety net: if we exit without hitting an explicit cleanup path
	// (e.g. SIGTERM, uncaught exception), this still restores the terminal.
	process.on('exit', cleanupTerminal)

	perf.mark('First draw')
	draw()
	perf.mark('First draw done')
	process.stdout.on('resize', () => draw(true))

	perf.mark('Ready for input')

	// Wire draft save/restore on tab switch.
	// Also swap prompt history so up-arrow recalls per-tab entries.
	client.setOnTabSwitch((fromSession, toSession) => {
		prompt.saveDraft(fromSession)
		prompt.restoreDraft(toSession)
		prompt.setHistory(client.getInputHistory())
		syncPromptToClient()
	})

	process.stdin.on('data', (data: Buffer) => {
		const cols = process.stdout.columns || 80
		// Prompt content area = terminal width minus the " " prefix
		const contentWidth = cols - 1

		for (const k of keys.parseKeys(data.toString('utf-8'))) {
			// Track key usage for help bar
			if (k.ctrl || k.alt || k.cmd || k.key === 'enter' || k.key === 'escape' || k.key === 'tab') {
				helpBar.logKey(canonicalKeyName(k))
			}
			// Completion keys first (tab, arrows in popup, etc.)
			if (handleCompletionKey(k)) {
				syncPromptToClient()
				draw()
				continue
			}
			// App keybindings
			if (handleAppKey(k)) continue
			// Then prompt editing
			if (prompt.handleKey(k, contentWidth)) {
				syncPromptToClient()
				draw()
			}
		}
	})
}

// Keep client.state in sync with prompt state (for rendering)
function syncPromptToClient(): void {
	client.setPrompt(prompt.text(), prompt.cursorPos())
}

export const cli = { startCli }
