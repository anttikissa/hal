// Inbox handler — watches for externally-queued messages.
//
// Other Hal instances (or `hal send`) drop .ason files into
// state/inbox/<session-id>/. This module watches that directory
// and feeds messages into the agent loop as if the user typed them.

import { readdirSync, readFileSync, unlinkSync } from 'fs'
import { watch } from 'fs'
import { STATE_DIR, ensureDir } from '../state.ts'
import { ipc } from '../file-ipc.ts'
import { ason } from '../../utils/ason.ts'

const INBOX_DIR = `${STATE_DIR}/inbox`

interface InboxMessage {
	sessionId: string
	text: string
	from?: string
	ts?: string
	queue?: boolean
	sourceTab?: number
}

type OnMessage = (sessionId: string, text: string, from?: string, queue?: boolean, sourceTab?: number) => void

const config = {
	// How often to rescan all inboxes even if no fs event arrived.
	pollIntervalMs: 2000,
	// Coalesce a burst of fs events into a single rescan.
	debounceMs: 50,
}

function parseInboxMessage(raw: unknown): InboxMessage | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const msg = raw as Record<string, unknown>
	if (typeof msg.sessionId !== 'string' || typeof msg.text !== 'string') return null
	return {
		sessionId: msg.sessionId,
		text: msg.text,
		from: typeof msg.from === 'string' ? msg.from : undefined,
		ts: typeof msg.ts === 'string' ? msg.ts : undefined,
		queue: msg.queue === true,
		sourceTab: typeof msg.sourceTab === 'number' && Number.isInteger(msg.sourceTab) && msg.sourceTab > 0 ? msg.sourceTab : undefined,
	}
}

function isOpen(sessionId: string): boolean {
	return ipc.readState().sessions.some((session) => session.id === sessionId)
}

/** Process any pending .ason files in a session's inbox directory. */
function processInbox(sessionDir: string, sessionId: string, openIds: Set<string>, onMessage: OnMessage): void {
	try {
		const files = readdirSync(sessionDir)
			.filter((f) => f.endsWith('.ason'))
			.sort()
		for (const file of files) {
			const path = `${sessionDir}/${file}`
			try {
				if (!openIds.has(sessionId)) return
				const content = readFileSync(path, 'utf-8')
				const msg = parseInboxMessage(ason.parse(content))
				if (msg?.text) onMessage(sessionId, msg.text, msg.from, msg.queue, msg.sourceTab)
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

/** Process pending messages in every session inbox directory. */
function scanAll(onMessage: OnMessage): void {
	try {
		// Recursive fs.watch can rescan while unrelated inbox directories change. Reloading
		// state once per directory serialized the whole tab list hundreds of times a second.
		const openIds = new Set(ipc.readState().sessions.map((session) => session.id))
		for (const sessionId of readdirSync(INBOX_DIR)) {
			processInbox(`${INBOX_DIR}/${sessionId}`, sessionId, openIds, onMessage)
		}
	} catch {}
}

/** Start watching the inbox directory for new messages. */
function startWatching(signal: AbortSignal, onMessage: OnMessage): void {
	ensureDir(INBOX_DIR)

	// Process any messages that arrived before we started watching
	scanAll(onMessage)

	// Poll as the safety net: fs.watch is not available everywhere and macOS
	// drops or coalesces events under load, so watching alone loses messages.
	const interval = setInterval(() => scanAll(onMessage), config.pollIntervalMs)
	signal.addEventListener('abort', () => clearInterval(interval), { once: true })

	// The watcher just makes delivery fast in the common case. We deliberately
	// ignore the reported filename: when a session directory is created and the
	// message written into it in quick succession, macOS reports only the
	// directory, so a filename-based dispatch would miss the first message to a
	// freshly spawned session.
	let timer: ReturnType<typeof setTimeout> | undefined
	function scheduleScan(): void {
		if (timer || signal.aborted) return
		timer = setTimeout(() => {
			timer = undefined
			if (!signal.aborted) scanAll(onMessage)
		}, config.debounceMs)
	}
	signal.addEventListener('abort', () => clearTimeout(timer), { once: true })

	try {
		const watcher = watch(INBOX_DIR, { recursive: true, persistent: false }, scheduleScan)
		signal.addEventListener('abort', () => watcher.close(), { once: true })
	} catch {
		// fs.watch unsupported here — the poll above still delivers messages.
	}
}

/** Queue a message for a session (used by `hal send` or the send tool). */
function queueMessage(sessionId: string, text: string, from?: string, queue?: boolean): void {
	const dir = `${INBOX_DIR}/${sessionId}`
	ensureDir(dir)
	const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.ason`
	const sourceTab = from ? ipc.readState().sessions.find((session) => session.id === from)?.tab : undefined
	const msg: InboxMessage = {
		sessionId,
		text,
		from: from ?? 'external',
		ts: new Date().toISOString(),
		...(queue ? { queue: true } : {}),
		...(sourceTab ? { sourceTab } : {}),
	}
	// Write atomically: write to temp, then rename
	const path = `${dir}/${filename}`
	Bun.write(path, ason.stringify(msg) + '\n')
}

export const inbox = { config, startWatching, queueMessage, scanAll, isOpen, inboxDir: () => INBOX_DIR }
