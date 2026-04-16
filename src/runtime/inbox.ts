// Inbox handler — watches for externally-queued messages.
//
// Other Hal instances (or `hal send`) drop .ason files into
// state/inbox/<session-id>/. This module watches that directory
// and feeds messages into the agent loop as if the user typed them.

import { readdirSync, readFileSync, unlinkSync } from 'fs'
import { watch } from 'fs'
import { STATE_DIR, ensureDir } from '../state.ts'
import { ason } from '../utils/ason.ts'

const INBOX_DIR = `${STATE_DIR}/inbox`

interface InboxMessage {
	sessionId: string
	text: string
	from?: string
	ts?: string
}

type OnMessage = (sessionId: string, text: string, from?: string) => void

function parseInboxMessage(raw: unknown): InboxMessage | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const msg = raw as Record<string, unknown>
	if (typeof msg.sessionId !== 'string' || typeof msg.text !== 'string') return null
	return {
		sessionId: msg.sessionId,
		text: msg.text,
		from: typeof msg.from === 'string' ? msg.from : undefined,
		ts: typeof msg.ts === 'string' ? msg.ts : undefined,
	}
}

/** Process any pending .ason files in a session's inbox directory. */
function processInbox(sessionDir: string, sessionId: string, onMessage: OnMessage): void {
	try {
		const files = readdirSync(sessionDir)
			.filter((f) => f.endsWith('.ason'))
			.sort()
		for (const file of files) {
			const path = `${sessionDir}/${file}`
			try {
				const content = readFileSync(path, 'utf-8')
				const msg = parseInboxMessage(ason.parse(content))
				if (msg?.text) onMessage(sessionId, msg.text, msg.from)
				// Delete after processing
				unlinkSync(path)
			} catch {
				// Malformed file — delete it to avoid infinite retries
				try {
					unlinkSync(path)
				} catch {}
			}
		}
	} catch {
		// Directory might not exist yet — that's fine
	}
}

/** Start watching the inbox directory for new messages. */
function startWatching(signal: AbortSignal, onMessage: OnMessage): void {
	ensureDir(INBOX_DIR)

	// Process any messages that arrived before we started watching
	try {
		const sessionDirs = readdirSync(INBOX_DIR)
		for (const sessionId of sessionDirs) {
			const sessionDir = `${INBOX_DIR}/${sessionId}`
			processInbox(sessionDir, sessionId, onMessage)
		}
	} catch {}

	// Watch for new files
	try {
		const watcher = watch(INBOX_DIR, { recursive: true, persistent: false }, (_event, filename) => {
			if (signal.aborted) return
			if (!filename || !filename.endsWith('.ason')) return

			// filename is like "session-id/message.ason"
			const slashIdx = filename.indexOf('/')
			if (slashIdx === -1) return
			const sessionId = filename.slice(0, slashIdx)
			const sessionDir = `${INBOX_DIR}/${sessionId}`
			processInbox(sessionDir, sessionId, onMessage)
		})

		// Close watcher when signal aborts
		signal.addEventListener('abort', () => watcher.close(), { once: true })
	} catch {
		// fs.watch might not be supported on all platforms — fall back to polling
		const interval = setInterval(() => {
			if (signal.aborted) {
				clearInterval(interval)
				return
			}
			try {
				const sessionDirs = readdirSync(INBOX_DIR)
				for (const sessionId of sessionDirs) {
					processInbox(`${INBOX_DIR}/${sessionId}`, sessionId, onMessage)
				}
			} catch {}
		}, 2000)
		signal.addEventListener('abort', () => clearInterval(interval), { once: true })
	}
}

/** Queue a message for a session (used by `hal send` or the send tool). */
function queueMessage(sessionId: string, text: string, from?: string): void {
	const dir = `${INBOX_DIR}/${sessionId}`
	ensureDir(dir)
	const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.ason`
	const msg: InboxMessage = {
		sessionId,
		text,
		from: from ?? 'external',
		ts: new Date().toISOString(),
	}
	// Write atomically: write to temp, then rename
	const path = `${dir}/${filename}`
	Bun.write(path, ason.stringify(msg) + '\n')
}

export const inbox = { startWatching, queueMessage }
