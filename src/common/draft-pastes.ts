// Lets the user turn paste markers in a draft back into the pasted text.
// It loads each marker's contents from the host (`paste-text` events),
// says why expansion cannot happen yet, and keeps the cursor and
// selection in place when it does.
import { attachments } from './attachments.ts'
import type { Event } from './protocol.ts'
import { uploads } from './uploads.ts'

type Paste = { text?: string; error?: string }
type Spot = { text: string; cursor: number; anchor?: number }

function create(sessionId: string, text: string) {
	let pastes = new Map<string, Paste>()
	let markers = attachments.markers(text).filter((m) => m.kind === 'paste')
	for (let m of markers) if (m.file && !uploads.inFlight(m.text)) pastes.set(m.file, {})
	function hint(current: string): { hint: string; invalid?: true } {
		let markers = attachments.markers(current).filter((m) => m.kind === 'paste')
		if (!markers.length) return { hint: 'No paste markers in the prompt you are writing', invalid: true }
		let lines = 0
		for (let m of markers) {
			if (uploads.inFlight(m.text)) return { hint: `Wait for paste upload: ${m.text}`, invalid: true }
			let p = m.file && pastes.get(m.file)
			if (!p) return { hint: `Cannot expand paste marker: ${m.text}`, invalid: true }
			if (p.error !== undefined) return { hint: p.error, invalid: true }
			if (p.text === undefined) return { hint: 'Load paste contents…', invalid: true }
			lines += p.text.split('\n').length
		}
		return {
			hint: `Replace ${markers.length} paste marker${markers.length === 1 ? '' : 's'} with their contents (${lines} lines).`,
		}
	}
	function accept(e: Event & { type: 'paste-text' }): boolean {
		if (e.sessionId !== sessionId || !pastes.has(e.name)) return false
		pastes.set(e.name, e.text === undefined ? { error: e.error ?? `No text for paste ${e.name}` } : { text: e.text })
		return true
	}
	function expand<P extends Spot>(draft: P): P | string {
		let status = hint(draft.text)
		if (status.invalid) return status.hint
		let out = { ...draft }
		for (let m of attachments
			.markers(draft.text)
			.filter((m) => m.kind === 'paste')
			.reverse()) {
			let text = pastes.get(m.file!)!.text!
			let end = m.at + m.text.length
			let move = (n: number) => (n <= m.at ? n : n >= end ? n + text.length - m.text.length : m.at + text.length)
			out.text = out.text.slice(0, m.at) + text + out.text.slice(end)
			out.cursor = move(out.cursor)
			if (out.anchor !== undefined) out.anchor = move(out.anchor)
		}
		return out
	}
	return { sessionId, names: [...pastes.keys()], hint, accept, expand }
}

export const draftPastes = { create }
