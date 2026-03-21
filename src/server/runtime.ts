// Server runtime — watches commands and generates responses.

import { appendEvent, tailCommands } from "../ipc.ts"

export function startRuntime(signal: AbortSignal): void {
	;(async () => {
		for await (const cmd of tailCommands(signal)) {
			if (cmd.type === "prompt") {
				appendEvent({ type: "prompt", text: cmd.text })
				appendEvent({ type: "response", text: `You said: ${cmd.text}` })
			}
		}
	})()
}
