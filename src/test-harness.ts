#!/usr/bin/env bun
// Test harness — headless mode for e2e tests.
// Processes raw key input via parseKeys + prompt, emits JSON events on stdout.
// Expects HAL_STATE_DIR to be set by the caller (parent process).

import { ensureStateDir } from './state.ts'
import { ensureBus, events, commands } from './ipc.ts'
import { startRuntime } from './runtime/startup.ts'
import { keys } from './cli/keys.ts'
import * as prompt from './cli/prompt.ts'
import { eventId, type RuntimeEvent } from './protocol.ts'

ensureStateDir()
await ensureBus()

// Grab tail offset BEFORE runtime starts, so we don't miss initial publish
const offset = await events.offset()
const runtime = await startRuntime()

function writeLine(record: any): void {
	process.stdout.write(JSON.stringify(record) + '\n')
}

// Tail events → JSON stdout
const tail = events.tail(offset)
;(async () => {
	for await (const event of tail.items) {
		const e = event as RuntimeEvent
		if (e.type === 'prompt') {
			writeLine({ type: 'prompt', sessionId: e.sessionId, text: e.text })
		} else if (e.type === 'status') {
			writeLine({ type: 'status', busy: e.busy })
		} else if (e.type === 'command') {
			writeLine({ type: 'command', phase: e.phase, commandId: (e as any).commandId })
		} else if (e.type === 'line') {
			writeLine({ type: 'line', sessionId: e.sessionId, text: e.text, level: e.level })
		} else if (e.type === 'sessions') {
			writeLine({ type: 'sessions', activeSessionId: e.activeSessionId, sessions: e.sessions.map(s => s.id) })
		}
	}
})()

writeLine({ type: 'ready' })

// Read raw stdin, parse keys, drive prompt
const { stdin } = process
stdin.resume()

function submitCommand(type: string, text?: string): void {
	commands.append({
		type, text, sessionId: runtime.activeSessionId,
		id: eventId(), createdAt: new Date().toISOString(),
	} as any)
}

stdin.on('data', (data: Buffer) => {
	const str = data.toString('utf8')
	for (const k of keys.parseKeys(str)) {
		if (k.key === 'enter' && !k.alt && !k.shift && !k.ctrl && !k.cmd) {
			const text = prompt.text()
			prompt.clear()
			if (!text.trim()) continue
			const slash = text.match(/^\/(\w+)(.*)/)
			if (slash) {
				submitCommand(slash[1], slash[2]?.trim() || undefined)
			} else {
				submitCommand('prompt', text)
			}
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
