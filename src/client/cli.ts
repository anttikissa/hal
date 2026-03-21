// CLI client — readline prompt and event display.

import { createInterface } from "readline"
import { appendCommand, tailEvents } from "../ipc.ts"

const RESTART_CODE = 100

export function startCli(signal: AbortSignal): void {
	// Display events
	;(async () => {
		for await (const event of tailEvents(signal)) {
			if (event.type === "prompt") {
				process.stdout.write(`\r\x1b[KYou: ${event.text}\n> `)
			} else if (event.type === "response") {
				process.stdout.write(`\r\x1b[KAssistant: ${event.text}\n> `)
			}
		}
	})()

	// Readline prompt
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "> ",
	})

	rl.prompt()

	rl.on("line", (line) => {
		if (line.trim()) {
			appendCommand({ type: "prompt", text: line })
		}
		rl.prompt()
	})

	rl.on("close", () => {
		process.exit(0)
	})

	// Ctrl-R restart
	if (process.stdin.isTTY) {
		process.stdin.on("keypress", (_ch: string, key: any) => {
			if (key?.ctrl && key.name === "r") {
				process.exit(RESTART_CODE)
			}
		})
	} else {
		const origEmit = process.stdin.emit.bind(process.stdin)
		process.stdin.emit = function (event: string, ...args: any[]) {
			if (event === "data") {
				const data = args[0] as Buffer
				for (const byte of data) {
					if (byte === 0x12) {
						process.exit(RESTART_CODE)
					}
				}
			}
			return origEmit(event, ...args)
		}
	}
}
