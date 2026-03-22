// CLI client -- raw terminal input, event display, prompt editing.
// See docs/terminal.md for rendering rules.

import { appendCommand, tailEvents, readAllEvents } from '../ipc.ts'
import { visLen, wordWrap } from '../utils/strings.ts'
import { paint, setFullscreen, isFullscreen } from './render.ts'

const RESTART_CODE = 100

// ── Types ────────────────────────────────────────────────────────────────────

type EntryType = 'input' | 'assistant' | 'info'

interface Entry {
	type: EntryType
	text: string
	ts?: number
}

interface Tab {
	sessionId: string
	name: string
	history: Entry[]
}

// ── State ────────────────────────────────────────────────────────────────────

let tabList: Tab[] = []
let currentTab = 0
let promptText = ''
let promptCursor = 0
let role: 'server' | 'client' = 'server'

// High-water mark: tallest history (in rendered lines) across all tabs.
let peak = 0

// ── Exports for main.ts ─────────────────────────────────────────────────────

export function addLocalBlock(text: string) {
	const tab = activeTab()
	if (tab) {
		tab.history.push({ type: 'info', text, ts: Date.now() })
		draw()
	}
}

export function setRole(r: 'server' | 'client') {
	role = r
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function activeTab(): Tab | null {
	return tabList[currentTab] ?? null
}

function formatTimestamp(ts?: number): string {
	if (ts === undefined) return ''
	const d = new Date(ts)
	const hh = String(d.getHours()).padStart(2, '0')
	const mm = String(d.getMinutes()).padStart(2, '0')
	const ss = String(d.getSeconds()).padStart(2, '0')
	const ms = String(d.getMilliseconds()).padStart(3, '0')
	return `\x1b[90m${hh}:${mm}:${ss}.${ms}\x1b[0m `
}

// ── Entry rendering ──────────────────────────────────────────────────────────

// ONE function that decides how an entry becomes terminal lines.
// Used by both renderHistory() and historyLineCount(). No drift possible.
function renderEntry(entry: Entry, cols: number): string[] {
	const ts = formatTimestamp(entry.ts)
	let prefix: string
	switch (entry.type) {
		case 'input':    prefix = `${ts}\x1b[36mYou:\x1b[0m `; break
		case 'assistant': prefix = `${ts}\x1b[33mAssistant:\x1b[0m `; break
		case 'info':     prefix = ts ? `${ts}\x1b[90m` : '\x1b[90m'; break
	}
	const suffix = entry.type === 'info' ? '\x1b[0m' : ''
	const result: string[] = []
	for (const raw of entry.text.split('\n')) {
		for (const wrapped of wordWrap(`${prefix}${raw}${suffix}`, cols)) {
			result.push(wrapped)
		}
		// After first line, continuation lines get indentation instead of prefix.
		prefix = ts ? '                  ' : '  '
	}
	return result
}

function historyLineCount(tab: Tab): number {
	const cols = process.stdout.columns || 80
	let count = 0
	for (const entry of tab.history) count += renderEntry(entry, cols).length
	return count
}

// ── Frame building ───────────────────────────────────────────────────────────

function renderHistory(lines: string[], tab: Tab): void {
	const cols = process.stdout.columns || 80
	for (const entry of tab.history) {
		for (const line of renderEntry(entry, cols)) lines.push(line)
	}
}

function renderTabBar(lines: string[]): void {
	lines.push(
		tabList.map((tab, i) =>
			i === currentTab
				? `\x1b[7m [${i + 1}] ${tab.name} \x1b[0m`
				: `  ${i + 1}  ${tab.name}  `
		).join('')
	)
}

function renderStatusLine(lines: string[], tab: Tab): void {
	const cols = process.stdout.columns || 80
	const mode = isFullscreen() ? 'full' : 'grow'
	const info = ` ${role} · pid ${process.pid} · ${mode} `
	const dashes = Math.max(0, cols - visLen(info) - 1)
	const left = Math.floor(dashes / 2)
	const right = dashes - left
	lines.push(`\x1b[90m${'─'.repeat(left)}${info}${'─'.repeat(right)}\x1b[0m`)
}

function renderPrompt(lines: string[]): void {
	const cols = process.stdout.columns || 80
	for (const line of wordWrap(`\x1b[32m>\x1b[0m ${promptText}`, cols)) {
		lines.push(line)
	}
}

function chromeLines(): number {
	const cols = process.stdout.columns || 80
	// tab bar (1) + status (1) + wrapped prompt
	return 2 + wordWrap(`> ${promptText}`, cols).length
}

function buildFrame(): string[] {
	const rows = process.stdout.rows || 24
	const chrome = chromeLines()
	const tab = activeTab()
	const lines: string[] = []

	// 1. History -- all entries, all lines, never sliced.
	if (tab) renderHistory(lines, tab)

	// Update peak across all tabs.
	for (const t of tabList) {
		const c = historyLineCount(t)
		if (c > peak) peak = c
	}

	// 2. Padding -- keeps prompt stable across tab switches.
	const contentHeight = Math.min(peak, Math.max(0, rows - chrome))
	const padding = Math.max(0, contentHeight - lines.length)
	for (let i = 0; i < padding; i++) lines.push('')

	// Check if frame exceeds terminal. Once true, never goes back.
	if (lines.length + chrome > rows) setFullscreen(true)

	// 3. Chrome.
	renderTabBar(lines)
	renderStatusLine(lines, tab ?? { sessionId: '', name: '', history: [] })
	renderPrompt(lines)

	return lines
}

// Cursor column: visible width of the end of typed text in the prompt.
function cursorCol(): number {
	const cols = process.stdout.columns || 80
	const wrapped = wordWrap(`> ${promptText}`, cols)
	const lastLine = wrapped[wrapped.length - 1]!
	return visLen(lastLine)
}

function draw(force = false): void {
	const lines = buildFrame()
	paint(lines, { force, cursorCol: cursorCol() })
}

// ── Tab/session management ───────────────────────────────────────────────────

function switchTab(index: number): void {
	if (index >= 0 && index < tabList.length && index !== currentTab) {
		currentTab = index
		draw(true)
	}
}

function sendCommand(type: string, text?: string): void {
	const tab = activeTab()
	appendCommand({ type, text, sessionId: tab?.sessionId })
}

function addEntryToTab(sessionId: string | null, entry: Entry): void {
	let tab = sessionId
		? tabList.find((t) => t.sessionId === sessionId)
		: activeTab()
	if (!tab) tab = activeTab()
	if (tab) {
		tab.history.push(entry)
		draw()
	}
}

// ── Event handling ───────────────────────────────────────────────────────────

function handleEvent(event: any): void {
	if (event.type === 'runtime-start' || event.type === 'host-released') return

	if (event.type === 'sessions') {
		const newTabs: Tab[] = []
		for (const s of event.sessions) {
			const existing = tabList.find((t) => t.sessionId === s.id)
			if (existing) {
				existing.name = s.name
				newTabs.push(existing)
			} else {
				newTabs.push({ sessionId: s.id, name: s.name, history: [] })
			}
		}
		const grew = newTabs.length > tabList.length
		tabList = newTabs
		if (currentTab >= tabList.length) currentTab = tabList.length - 1
		if (grew) currentTab = tabList.length - 1
		draw()
	} else if (event.type === 'prompt') {
		addEntryToTab(event.sessionId, {
			type: 'input',
			text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'response') {
		addEntryToTab(event.sessionId, {
			type: 'assistant',
			text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	} else if (event.type === 'info') {
		addEntryToTab(event.sessionId ?? null, {
			type: 'info',
			text: event.text,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	}
}

function eventsForCurrentRuntime(events: any[]): any[] {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.type === 'runtime-start') return events.slice(i + 1)
	}
	return events
}

// ── Input handling ───────────────────────────────────────────────────────────

export function startCli(signal: AbortSignal): void {
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
	}

	// Bootstrap: replay current runtime events to get sessions + history.
	for (const event of eventsForCurrentRuntime(readAllEvents())) {
		handleEvent(event)
	}

	draw()

	// Watch for new events.
	void (async () => {
		for await (const event of tailEvents(signal)) {
			handleEvent(event)
		}
	})()

	process.stdout.on('resize', () => draw(true))

	process.stdin.on('data', (data: Buffer) => {
		for (let i = 0; i < data.length; i++) {
			const byte = data[i]!

			// Ctrl-R: restart
			if (byte === 0x12) {
				if (process.stdin.isTTY) process.stdin.setRawMode(false)
				process.exit(RESTART_CODE)
			}

			// Ctrl-C / Ctrl-D: quit
			if (byte === 0x03 || byte === 0x04) {
				if (process.stdin.isTTY) process.stdin.setRawMode(false)
				process.stdout.write('\r\n')
				process.exit(0)
			}

			// Ctrl-T: new tab
			if (byte === 0x14) { sendCommand('open'); continue }

			// Ctrl-W: close tab
			if (byte === 0x17) {
				if (tabList.length > 1) sendCommand('close')
				continue
			}

			// Ctrl-N: next tab
			if (byte === 0x0e) {
				switchTab((currentTab + 1) % tabList.length)
				continue
			}

			// Ctrl-P: previous tab
			if (byte === 0x10) {
				switchTab((currentTab - 1 + tabList.length) % tabList.length)
				continue
			}

			// Ctrl-L: force redraw
			if (byte === 0x0c) { draw(true); continue }

			// Enter
			if (byte === 0x0d || byte === 0x0a) {
				if (promptText.trim()) sendCommand('prompt', promptText)
				promptText = ''
				promptCursor = 0
				draw()
				continue
			}

			// Backspace
			if (byte === 0x7f || byte === 0x08) {
				if (promptCursor > 0) {
					promptText = promptText.slice(0, promptCursor - 1) + promptText.slice(promptCursor)
					promptCursor--
					draw()
				}
				continue
			}

			// Escape sequences (arrows)
			if (byte === 0x1b && i + 2 < data.length && data[i + 1] === 0x5b) {
				const code = data[i + 2]
				if (code === 0x44 && promptCursor > 0) { promptCursor--; draw() }
				if (code === 0x43 && promptCursor < promptText.length) { promptCursor++; draw() }
				i += 2
				continue
			}

			// Printable ASCII
			if (byte >= 0x20 && byte < 0x7f) {
				const ch = String.fromCharCode(byte)
				promptText = promptText.slice(0, promptCursor) + ch + promptText.slice(promptCursor)
				promptCursor++
				draw()
				continue
			}
		}
	})
}
