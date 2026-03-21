// CLI client — raw terminal input, event display, prompt editing.

import { appendCommand, tailEvents } from "../ipc.ts"
import { render, type RenderState } from "./render.ts"

const RESTART_CODE = 100

interface Block {
	type: "input" | "assistant" | "info"
	text: string
}

let blocks: Block[] = []
let promptText = ""
let promptCursor = 0
let currentTab = 0
let tabs = ["main"]

function blockToString(block: Block): string {
	if (block.type === "input") return `\x1b[36mYou:\x1b[0m ${block.text}`
	if (block.type === "assistant") return `\x1b[33mAssistant:\x1b[0m ${block.text}`
	return `\x1b[90m${block.text}\x1b[0m`
}

function renderTabBar(): string {
	return tabs
		.map((name, i) =>
			i === currentTab
				? `\x1b[7m ${i + 1} ${name} \x1b[0m`
				: ` ${i + 1} ${name} `,
		)
		.join("")
}

function renderSeparator(): string {
	const cols = process.stdout.columns || 80
	return "\x1b[90m" + "─".repeat(cols) + "\x1b[0m"
}

function renderPrompt(): string {
	return `\x1b[32m>\x1b[0m ${promptText}`
}

function draw() {
	const state: RenderState = {
		blocks: blocks.map(blockToString),
		tabs: renderTabBar(),
		separator: renderSeparator(),
		prompt: renderPrompt(),
		cursorCol: promptCursor + 2, // 2 = "> " prefix
	}
	render(state)
}

export function startCli(signal: AbortSignal): void {
	// Enter raw mode
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
	}

	// Initial draw
	draw()

	// Tail events
	void (async () => {
		for await (const event of tailEvents(signal)) {
			if (event.type === "prompt") {
				blocks.push({ type: "input", text: event.text })
				draw()
			} else if (event.type === "response") {
				blocks.push({ type: "assistant", text: event.text })
				draw()
			} else if (event.type === "info") {
				blocks.push({ type: "info", text: event.text })
				draw()
			} else if (event.type === "host-released") {
				// handled by main.ts
			}
		}
	})()

	// Handle raw input
	process.stdin.on("data", (data: Buffer) => {
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
				process.exit(0)
			}

			// Enter: submit
			if (byte === 0x0d || byte === 0x0a) {
				if (promptText.trim()) {
					appendCommand({ type: "prompt", text: promptText })
				}
				promptText = ""
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
				// Left arrow
				if (code === 0x44 && promptCursor > 0) {
					promptCursor--
					draw()
				}
				// Right arrow
				if (code === 0x43 && promptCursor < promptText.length) {
					promptCursor++
					draw()
				}
				i += 2
				continue
			}

			// Printable character
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
