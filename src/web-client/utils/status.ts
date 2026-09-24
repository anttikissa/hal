import type { SharedSessionInfo } from '../../common/ipc.ts'
import type { LiveBlock } from '../../common/live-event-blocks.ts'
import { models } from '../../common/models.ts'
import type { SessionMeta } from '../../common/session.ts'

// The phone version of the terminal status line, split over two rows because a
// phone header only has room for one. `text` is the header: who am I and how
// full is the context. `location` sits above the composer and answers where and
// with what this prompt will run, keeping the terminal's cwd-then-model pairing.

function contextText(meta: SessionMeta | undefined): string {
	const context = meta?.context
	if (!context || context.max <= 0) return ''
	const percent = Math.round((context.used / context.max) * 100)
	return `${models.formatTokenCount(context.used)}/${models.formatTokenCount(context.max)} (${percent}%)`
}

// A session name equal to the id carries no information, so drop the suffix.
function sessionText(session: SharedSessionInfo): string {
	if (!session.name || session.name === session.id) return session.id
	return `${session.id}: ${session.name}`
}

function location(session: SharedSessionInfo | undefined): string {
	if (!session) return ''
	return [session.cwd, models.displayModel(session.model)].filter(Boolean).join(' · ')
}

function text(session: SharedSessionInfo | undefined): string {
	if (!session) return ''
	return webStatus.sessionText(session)
}

function activity(working: boolean, reconnecting: boolean, waiting: boolean, live: readonly LiveBlock[] = []): string {
	if (reconnecting) return 'Reconnecting…'
	if (waiting) return 'Waiting for answer'
	if (!working) return 'Idle'
	let tools = 0
	let toolName = ''
	for (const block of live) {
		if (block.type !== 'tool' || !block.running) continue
		tools++
		toolName = block.name
	}
	if (tools > 1) return `Running ${tools} tools`
	if (tools === 1) return `Running ${toolName}`
	for (const block of [...live].reverse()) {
		if (block.type === 'assistant' && block.streaming) return 'Writing'
		if (block.type === 'thinking' && block.streaming) return 'Thinking'
	}
	// Stream-end lands before working=false; avoid flashing Processing after the answer.
	if (live.at(-1)?.type === 'assistant') return 'Idle'
	return 'Processing'
}

export const webStatus = { text, location, contextText, sessionText, activity }
