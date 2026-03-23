// CLI -- terminal input handling. See docs/terminal.md for rules.
// Thin layer: parses keys, dispatches to prompt or app keybindings.

import { client } from '../client.ts'
import { render } from './render.ts'
import { keys } from '../cli/keys.ts'
import { prompt } from '../cli/prompt.ts'
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

function draw(force = false): void { render.draw(force) }

// Restore terminal state before exiting. Must be called on ALL exit paths
// or the terminal will be left in raw/kitty mode.
function cleanupTerminal(): void {
	if (useKitty) process.stdout.write(KITTY_OFF)
	process.stdout.write(BRACKETED_PASTE_OFF)
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
}

function submit(): void {
	const text = prompt.text().trim()
	if (!text) return
	prompt.pushHistory(text)
	client.sendCommand('prompt', text)
	prompt.clear()
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
	if (k.key === 'l' && k.ctrl) { draw(true); return true }
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
	if (k.key === 'n' && k.ctrl) { client.nextTab(); return true }
	if (k.key === 'p' && k.ctrl) { client.prevTab(); return true }
	// Enter: submit
	if (k.key === 'enter' && !k.shift) { submit(); draw(); return true }
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

	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
		if (useKitty) process.stdout.write(KITTY_ON)
		process.stdout.write(BRACKETED_PASTE_ON)
	}

	draw()
	process.stdout.on('resize', () => draw(true))

	process.stdin.on('data', (data: Buffer) => {
		const cols = process.stdout.columns || 80
		// Prompt content area = terminal width minus the " " prefix
		const contentWidth = cols - 1

		for (const k of keys.parseKeys(data.toString('utf-8'))) {
			// App keybindings first
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
