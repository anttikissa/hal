// CLI client — raw terminal input, event display, prompt editing.
// See docs/terminal.md for rendering rules.

import { appendCommand, tailEvents, readAllEvents } from '../ipc.ts'
import {
	clearFrame,
	getRenderMetrics,
	render,
	type RenderMetrics,
	type RenderState,
} from './render.ts'

const RESTART_CODE = 100

interface Block {
	type: 'input' | 'assistant' | 'info'
	text: string
}

interface Tab {
	sessionId: string
	name: string
	blocks: Block[]
}

let tabList: Tab[] = []
let currentTab = 0
let promptText = ''
let promptCursor = 0
let role: 'server' | 'client' = 'server'

function activeTab(): Tab | null {
	return tabList[currentTab] ?? null
}

function addBlockToTab(sessionId: string | null, block: Block) {
	let tab = sessionId
		? tabList.find((t) => t.sessionId === sessionId)
		: activeTab()
	// If event arrives before sessions sync, add to active tab anyway
	if (!tab) tab = activeTab()
	if (tab) {
		tab.blocks.push(block)
		draw()
	}
}

export function addLocalBlock(text: string) {
	const tab = activeTab()
	if (tab) {
		tab.blocks.push({ type: 'info', text })
		draw()
	}
}

export function setRole(r: 'server' | 'client') {
	role = r
}

function blockToString(block: Block): string {
	if (block.type === 'input') return `\x1b[36mYou:\x1b[0m ${block.text}`
	if (block.type === 'assistant')
		return `\x1b[33mAssistant:\x1b[0m ${block.text}`
	return block.text
		.split('\n')
		.map((line) => `\x1b[90m${line}\x1b[0m`)
		.join('\n')
}

function renderTabBar(): string {
	return tabList
		.map((tab, i) =>
			i === currentTab
				? `\x1b[7m ${i + 1} ${tab.name} \x1b[0m`
				: ` ${i + 1} ${tab.name} `,
		)
		.join('')
}

function renderSeparator(metrics: RenderMetrics): string {
	const cols = process.stdout.columns || 80
	const debug = `content=${metrics.contentLines} pad=${metrics.padding} max=${metrics.maxContentHeight} total=${metrics.totalLines}`
	const info = ` ${role} · pid ${process.pid} `
	const dashes = Math.max(0, cols - info.length)
	const left = Math.floor(dashes / 2)
	const right = dashes - left
	return (
		'\x1b[90m' + debug + '\x1b[0m\n' +
		'\x1b[90m' + '─'.repeat(left) + info + '─'.repeat(right) + '\x1b[0m'
	)
}

function renderPrompt(): string {
	return `\x1b[32m>\x1b[0m ${promptText}`
}

function countBlockLines(blocks: Block[]): number {
	let count = 0
	for (const b of blocks) {
		count += blockToString(b).split("\n").length
	}
	return count
}

function draw() {
	const tab = activeTab()
	const blocks = tab ? tab.blocks.map(blockToString) : []
	const allTabBlockCounts = tabList.map((t) => countBlockLines(t.blocks))
	const tabs = renderTabBar()
	const prompt = renderPrompt()
	const metrics = getRenderMetrics(
		{ blocks, allTabBlockCounts, tabs, prompt },
		2,
	)
	const state: RenderState = {
		blocks,
		allTabBlockCounts,
		tabs,
		separator: renderSeparator(metrics),
		prompt,
		cursorCol: promptCursor + 2,
	}
	render(state)
}

function switchTab(index: number) {
	if (index >= 0 && index < tabList.length) {
		currentTab = index
		draw()
	}
}

function sendCommand(type: string, text?: string) {
	const tab = activeTab()
	appendCommand({
		type,
		text,
		sessionId: tab?.sessionId,
	})
}

function handleEvent(event: any) {
	if (event.type === 'runtime-start' || event.type === 'host-released') {
		// runtime coordination events are handled elsewhere
		return
	}

	if (event.type === 'sessions') {
		const newTabs: Tab[] = []
		for (const s of event.sessions) {
			const existing = tabList.find((t) => t.sessionId === s.id)
			if (existing) {
				existing.name = s.name
				newTabs.push(existing)
			} else {
				newTabs.push({ sessionId: s.id, name: s.name, blocks: [] })
			}
		}
		const grew = newTabs.length > tabList.length
		tabList = newTabs
		if (currentTab >= tabList.length) currentTab = tabList.length - 1
		if (grew) currentTab = tabList.length - 1
		draw()
	} else if (event.type === 'prompt') {
		addBlockToTab(event.sessionId, { type: 'input', text: event.text })
	} else if (event.type === 'response') {
		addBlockToTab(event.sessionId, {
			type: 'assistant',
			text: event.text,
		})
	} else if (event.type === 'info') {
		addBlockToTab(event.sessionId ?? null, {
			type: 'info',
			text: event.text,
		})
	}
}

function eventsForCurrentRuntime(events: any[]): any[] {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.type === 'runtime-start') {
			return events.slice(i + 1)
		}
	}
	return events
}

export function startCli(signal: AbortSignal): void {
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
	}

	// Bootstrap: replay current runtime events to get sessions + history
	for (const event of eventsForCurrentRuntime(readAllEvents())) {
		handleEvent(event)
	}

	draw()

	void (async () => {
		for await (const event of tailEvents(signal)) {
			handleEvent(event)
			// host-released handled by main.ts
		}
	})()

	process.stdin.on('data', (data: Buffer) => {
		for (let i = 0; i < data.length; i++) {
			const byte = data[i]!

			// Ctrl-R: restart
			if (byte === 0x12) {
				clearFrame()
				if (process.stdin.isTTY) process.stdin.setRawMode(false)
				process.exit(RESTART_CODE)
			}

			// Ctrl-C / Ctrl-D: quit
			if (byte === 0x03 || byte === 0x04) {
				if (process.stdin.isTTY) process.stdin.setRawMode(false)
				process.exit(0)
			}

			// Ctrl-T: new tab
			if (byte === 0x14) {
				sendCommand('open')
				continue
			}

			// Ctrl-W: close tab
			if (byte === 0x17) {
				if (tabList.length > 1) {
					sendCommand('close')
				}
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

			// Ctrl-L: force full redraw of current tab
			if (byte === 0x0c) {
				clearFrame()
				draw()
				continue
			}

			// Enter
			if (byte === 0x0d || byte === 0x0a) {
				if (promptText.trim()) {
					sendCommand('prompt', promptText)
				}
				promptText = ''
				promptCursor = 0
				draw()
				continue
			}

			// Backspace
			if (byte === 0x7f || byte === 0x08) {
				if (promptCursor > 0) {
					promptText =
						promptText.slice(0, promptCursor - 1) +
						promptText.slice(promptCursor)
					promptCursor--
					draw()
				}
				continue
			}

			// Escape sequences
			if (byte === 0x1b && i + 2 < data.length && data[i + 1] === 0x5b) {
				const code = data[i + 2]
				if (code === 0x44 && promptCursor > 0) {
					promptCursor--
					draw()
				}
				if (code === 0x43 && promptCursor < promptText.length) {
					promptCursor++
					draw()
				}
				i += 2
				continue
			}

			// Printable
			if (byte >= 0x20 && byte < 0x7f) {
				const ch = String.fromCharCode(byte)
				promptText =
					promptText.slice(0, promptCursor) +
					ch +
					promptText.slice(promptCursor)
				promptCursor++
				draw()
				continue
			}
		}
	})
}
