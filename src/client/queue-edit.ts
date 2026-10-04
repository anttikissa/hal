// Terminal adapter for the shared protected queue editor (task jsg).
import { queueEdit } from '../common/queue-edit.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { prompt } from '../common/prompt.ts'
import type { PromptKeysState } from './prompt-keys.ts'
import type { KeyEvent } from './keys.ts'

function key(st: PromptKeysState, k: KeyEvent): boolean {
	let t = st.transcript
	if (!t) return false
	let id = t.meta.id
	let plain = !k.shift && !k.ctrl && !k.alt && !k.cmd
	let e = queueEdit.current(id)
	if (e?.active && e.saving) return true
	if (e?.active && plain && (k.key === 'escape' || (k.key === 'down' && st.prompt.text === e.original))) {
		queueEdit.cancel(id)
		st.editing = undefined
		st.prompt = { ...prompt.cleared(st.prompt), text: drafts.text(id), cursor: drafts.text(id).length }
		return true
	}
	if (plain && k.key === 'up' && !st.editing && !st.prompt.text) {
		let waiting = queueEdit.candidate(t)
		if (waiting) return queueEdit.begin(t, waiting.id)
	}
	return false
}
function sync(st: PromptKeysState & { notice?: string }, event?: Event): void {
	let id = st.transcript?.meta.id
	if (!id) return
	let editing = queueEdit.editing(id)
	if (editing) {
		st.editing = editing
		let text = queueEdit.text(id)
		if (st.prompt.text !== text) st.prompt = { ...st.prompt, text, cursor: text.length }
	} else if (st.editing?.queueEdit) {
		st.editing = undefined
		let text = drafts.text(id)
		st.prompt = { ...prompt.cleared(st.prompt), text, cursor: text.length }
	}
	if (event?.type === 'rejected') st.notice = `${event.command} refused: ${event.reason}`
}
export const queuedPrompt = { key, sync }
