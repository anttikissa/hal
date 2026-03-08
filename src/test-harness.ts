#!/usr/bin/env bun
// Test harness — headless mode for e2e tests.
// Processes raw key input via parseKeys + prompt, emits JSON events on stdout.
// Expects HAL_STATE_DIR to be set by the caller (parent process).

import { ensureStateDir } from './state.ts'
import { ensureBus, events, commands } from './ipc.ts'
import { startRuntime } from './runtime/runtime.ts'
import { parseKeys } from './cli/keys.ts'
import * as prompt from './cli/prompt.ts'
import { eventId, type RuntimeEvent } from './protocol.ts'

ensureStateDir()
await ensureBus()

const runtime = await startRuntime()

function writeLine(record: any): void {
	process.stdout.write(JSON.stringify(record) + '\n')
}

// Tail events → JSON stdout
const offset = await events.offset()
const tail = events.tail(offset)
;(async () => {
	for await (const event of tail.items) {
		const e = event as RuntimeEvent
		if (e.type === 'prompt') {
			writeLine({ type: 'prompt', sessionId: e.sessionId, text: e.text })
		} else if (e.type === 'status') {
			writeLine({ type: 'status', busy: e.busy })
		} else if (e.type === 'command') {
			writeLine({ type: 'command', phase: e.phase })
		}
	}
})()

writeLine({ type: 'ready' })

// Read raw stdin, parse keys, drive prompt
const { stdin } = process
stdin.resume()

function submitPrompt(text: string): void {
	commands.append({
		type: 'prompt', text, sessionId: runtime.activeSessionId,
		id: eventId(), createdAt: new Date().toISOString(),
	} as any)
}

stdin.on('data', (data: Buffer) => {
	const str = data.toString('utf8')
	for (const k of parseKeys(str)) {
		if (k.key === 'enter' && !k.alt && !k.shift && !k.ctrl && !k.cmd) {
			const text = prompt.text()
			prompt.clear()
			if (text.trim()) submitPrompt(text)
			continue
		}
		if (k.key === 'enter' && (k.shift || k.alt)) {
			prompt.handleKey(k, 80)
			continue
		}
		prompt.handleKey(k, 80)
	}
})

stdin.on('end', () => {
	runtime.stop()
	tail.cancel()
	process.exit(0)
})
