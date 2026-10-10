// Hal facts, not human prompts. Delivery is frozen on an existing user
// record before a request; sources remain in history for the UI.
// Tasks: nzv, nvm.
import type { HistoryRecord, TurnStatus } from './replay.ts'

export type Notice = { source: number; text: string; sectionUpdate?: true }
type Known = { cwd?: string; model?: string; end?: TurnStatus; waiting?: string }

function text(r: HistoryRecord, known: Known): string | undefined {
	let lines: string[] = []
	if (r.type === 'notice' && r.rendered) return r.text
	if (r.type === 'notice') lines.push(r.text)
	if (r.type === 'user' && r.naming) return r.noticeSuppressed ? undefined : modelNotices.naming(r.naming)
	if (r.type === 'change') for (let key of ['cwd', 'model'] as const) {
		let value = r[key]
		if (value === undefined) continue
		known[key] = value
	}
	if (r.type === 'assistant' && r.model !== undefined && known.model === undefined) known.model = r.effort ? `${r.model}:${r.effort}` : r.model
	if (r.type === 'output' && r.change && !r.change.sectionOnly) lines.push(`The user edited your instructions. The system prompt you see is current; earlier replies followed the old text. ${r.text}`)
	if (r.type === 'question' && r.call !== undefined) known.waiting = r.id
	if (r.type === 'answer' && r.question === known.waiting) known.waiting = undefined
	if (r.type === 'turn_end') {
		known.end = r.status
		known.waiting = undefined
		if (r.status !== 'completed') lines.push(r.status === 'error' ? `The turn failed with an error: ${r.error ?? 'unknown error'}` : r.pauseReason !== undefined ? `Hal paused the turn: ${r.pauseReason}` : r.status === 'interrupted' ? 'The turn was interrupted.' : 'The user paused the turn.')
	}
	if (r.type === 'continue' && known.waiting === undefined) lines.push(r.reason ?? (known.end === 'error' ? 'The user asked to retry the failed turn.' : known.end === undefined ? 'The unfinished turn is continuing. Do not repeat completed work.' : 'The user resumed the paused turn. Do not repeat completed work.'))
	if (r.type === 'assistant' || r.type === 'continue') known.end = undefined
	return lines.length && !r.noticeSuppressed ? `<hal-note>${r.ts}\n${lines.join('\n')}</hal-note>` : undefined
}

// Legacy prompts implicitly delivered earlier facts. New boundary records
// freeze both their source numbers and text, so later facts never move into
// an earlier request. Clear/compact decide what context remains.
function pending(records: HistoryRecord[], raw = records): Notice[] {
	let materialized = new Set(raw.flatMap((r) => r.type === 'notice' && r.source !== undefined ? [r.source] : []))
	let waiting: Notice[] = []
	let known: Known = {}
	for (let [i, r] of records.entries()) {
		if (r.type === 'reset' || r.type === 'compact') waiting = []
		if (r.type === 'user') {
			let sent = new Set(r.notices?.map((n) => n.source))
			waiting = r.notices === undefined && r.blocks.some((b) => b.type === 'text') ? [] : waiting.filter((n) => !sent.has(n.source))
		}
		let message = modelNotices.text(r, known)
		if (message && !materialized.has(r.n ?? i + 1)) waiting.push({ source: r.n ?? i + 1, text: message, ...(r.type === 'notice' && r.sectionUpdate && { sectionUpdate: true }) })
	}
	return waiting
}

function naming(n: NonNullable<Extract<HistoryRecord, { type: 'user' }>['naming']>): string {
	return `<hal-note>Current session name: ${JSON.stringify(n.name)}.${n.eligible ? ' If this is a placeholder or no longer describes the main task, use the command tool to run /rename with a specific 3–7-word human-readable description, at most 60 Unicode characters, in the user language. Do not copy the user request or rename merely to polish wording. Never emit XML rename tags. Do not answer this metadata.' : ''}</hal-note>`
}

export const modelNotices = { text, pending, naming }
