// CLI -- terminal input handling. Thin layer: reads keypresses, calls client
// for state changes, renderer for display. See docs/terminal.md for rules.

import { client } from '../client.ts'
import { render } from './render.ts'
import { perf } from '../perf.ts'

const RESTART_CODE = 100

function startCli(signal: AbortSignal): void {
	// Wire client state changes to terminal repaint.
	client.setOnChange((force) => render.draw(force))

	// Bootstrap client (replays IPC log, starts tailing events).
	client.startClient(signal)

	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
	}

	render.draw()
	perf.mark('First render done')

	process.stdout.on('resize', () => render.draw(true))

	process.stdin.on('data', (data: Buffer) => {
		for (let i = 0; i < data.length; i++) {
			const byte = data[i]!

			// Ctrl-R: restart. Clear the frame so the new process paints fresh.
			if (byte === 0x12) {
				render.clearFrame()
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
			if (byte === 0x14) { client.sendCommand('open'); continue }

			// Ctrl-W: close tab
			if (byte === 0x17) {
				if (client.state.tabs.length > 1) client.sendCommand('close')
				continue
			}

			// Ctrl-N / Ctrl-P: tab switching
			if (byte === 0x0e) { client.nextTab(); continue }
			if (byte === 0x10) { client.prevTab(); continue }

			// Ctrl-L: force redraw
			if (byte === 0x0c) { render.draw(true); continue }

			// Enter
			if (byte === 0x0d || byte === 0x0a) {
				if (client.state.promptText.trim()) client.sendCommand('prompt', client.state.promptText)
				client.clearPrompt()
				continue
			}

			// Backspace
			if (byte === 0x7f || byte === 0x08) {
				if (client.state.promptCursor > 0) {
					const t = client.state.promptText
					const c = client.state.promptCursor
					client.setPrompt(t.slice(0, c - 1) + t.slice(c), c - 1)
				}
				continue
			}

			// Arrow keys
			if (byte === 0x1b && i + 2 < data.length && data[i + 1] === 0x5b) {
				const code = data[i + 2]
				if (code === 0x44 && client.state.promptCursor > 0)
					client.setPrompt(client.state.promptText, client.state.promptCursor - 1)
				if (code === 0x43 && client.state.promptCursor < client.state.promptText.length)
					client.setPrompt(client.state.promptText, client.state.promptCursor + 1)
				i += 2
				continue
			}

			// Printable ASCII
			if (byte >= 0x20 && byte < 0x7f) {
				const ch = String.fromCharCode(byte)
				const t = client.state.promptText
				const c = client.state.promptCursor
				client.setPrompt(t.slice(0, c) + ch + t.slice(c), c + 1)
				continue
			}
		}
	})

	perf.mark('Client ready to read input')

}

export const cli = { startCli }
