// Editing the last message the user sent (tasks/j1/states.md, task
// dg), the part every client shares. Up on an empty prompt loads it into
// the editor. A message still waiting in the inbox is edited in place
// there, with no pause: the model never saw it. Otherwise, while the
// model works, Up pauses the turn and edits the last prompt; Enter sends
// the edit, and the host decides from history whether it replaces that
// prompt (only reading happened since) or goes on top (something
// changed). Down with the text unchanged, or Escape, continues the
// paused turn. Messages another session sent (`from`) are never
// recalled.
// Tasks: rqq.

import { drafts } from './drafts.ts'
import { literal } from './literal.ts'
import { states } from './states.ts'
import { toolDetails } from './tool-details.ts'
import type { Item, Transcript } from './transcript.ts'

// An edit in progress: of which session's message, its text then, and
// `inbox`: the id of the waiting message edited, if it is one. From an
// Edit button (task 26q): `aside`, the draft is set aside meanwhile
// (the box shows the edit, the draft stays as it was and comes back
// after, as in history browsing); `paused`, whether beginning paused the turn (cancel continues
// it only then); and for an earlier prompt, `rewind`, its record
// number, `later`, how many messages follow it, and `changed`, whether
// tools with side effects ran since.
export type Editing = { sessionId: string; original: string; target?: string; inbox?: string; aside?: true; paused?: boolean; rewind?: number; later?: number; changed?: boolean; queueEdit?: string }

const mine = (i: Item): i is Item & { type: 'prompt' } => i.type === 'prompt' && i.from === undefined && i.origin !== 'model'

// Keys of the prompts the human sent since the latest compaction (a
// clear leaves no items before it): each has an Edit button. A record
// delivering several texts is edited by its first (key `n`).
function editable(items: Item[]): Set<string> {
	let out = new Set<string>()
	for (let i of items) {
		if (i.type === 'divider' && i.text.startsWith('Context compacted')) out.clear()
		else if (mine(i) && /^\d+$/.test(i.key)) out.add(i.key)
	}
	return out
}

// The Edit button of prompt `key`: the edit to
// start and the pause to send while the session works. The newest
// prompt is the usual edit of the last prompt (enter decides on the
// host); an earlier one rewinds there.
function at(t: Transcript, key: string): { editing: Editing; command?: unknown } | undefined {
	let i = t.items.findIndex((x) => x.key === key)
	let item = t.items[i]
	if (!item || !mine(item) || !amend.editable(t.items).has(key)) return undefined
	let sessionId = t.meta.id
	let command = states.busy(t.state) ? { type: 'pause', sessionId } : undefined
	let editing: Editing = { sessionId, original: literal.escape(item.text), target: key, aside: true, paused: !!command }
	let after = t.items.slice(i + 1)
	editing.changed = after.some((x) => x.type === 'tool' && !toolDetails.harmless(x.name, x.input))
	if (t.items.findLast(mine) !== item) {
		editing.rewind = Number(key)
		editing.later = after.filter((x) => !['turn-end', 'divider', 'tool-result', 'image'].includes(x.type)).length
	}
	return command ? { editing, command } : { editing }
}

// Up with `text` in the editor: the edit to start and the pause to
// send (none for a waiting message), or undefined when Up means
// nothing here.
function begin(t: Transcript | undefined, text: string): { editing: Editing; command?: unknown } | undefined {
	if (!t || text !== '') return undefined
	let sessionId = t.meta.id
	// Queued messages require queueEdit.begin and its host handshake.
	if (t.inbox.some((m) => m.delivery === 'after-turn' && m.from === undefined && m.origin !== 'model')) return undefined
	// A prompt sent and not acknowledged yet is the last one, though the
	// transcript lacks it (a slow link). The host knows it by its id, in
	// the inbox or in history. Sent to a working session it steers (no
	// pause); otherwise it starts a turn, which Up pauses.
	let sent = drafts.pending(sessionId).at(-1)
	if (sent?.delivery === 'queue') return undefined
	if (sent && !/^\/[a-z]/i.test(sent.text.trimStart())) {
		let editing: Editing = { sessionId, original: sent.text, inbox: sent.id }
		return states.busy(t.state) ? { editing } : { editing: { ...editing, paused: true }, command: { type: 'pause', sessionId } }
	}
	let waiting = t.inbox.findLast((m) => m.from === undefined && m.origin !== 'model')
	if (waiting) return { editing: { sessionId, original: literal.escape(waiting.text), inbox: waiting.id } }
	if (!states.busy(t.state)) return undefined
	let last = t.items.findLast(mine)
	if (!last) return undefined
	let changed = t.items.slice(t.items.indexOf(last) + 1).some((i) => i.type === 'tool' && !toolDetails.harmless(i.name, i.input))
	return { editing: { sessionId, original: literal.escape(last.text), target: last.key, changed, paused: true }, command: { type: 'pause', sessionId } }
}

// Enter while editing. Alt-Enter (`queue`) and an emptied editor act as
// they do anywhere: queue a new message, or continue.
function enter(editing: Editing, t: Transcript | undefined, text: string, queue = false): unknown {
	if (editing.queueEdit) return undefined
	if (!queue && text === editing.original) return resume(editing, t)
	if (queue || !text.trim()) return states.enter(editing.sessionId, t?.state ?? { type: 'idle' }, text, queue ? 'queue' : 'steer').command
	if (editing.changed) return { type: 'submit', sessionId: editing.sessionId, text }
	if (editing.inbox !== undefined) return { type: 'submit', sessionId: editing.sessionId, text, amend: true, edits: editing.inbox }
	return { type: 'submit', sessionId: editing.sessionId, text: `/edit ${parseInt(editing.target!)}\n${text}` }
}

// Leaving the edit (Down unchanged, Escape): continue the paused turn,
// or the one whose pause is still on its way; nothing if it ended or
// was never paused (a waiting message was edited).
function resume(editing: Editing, t: Transcript | undefined): unknown {
	if (editing.queueEdit || !t || t.meta.id !== editing.sessionId || (editing.inbox !== undefined && !editing.paused) || editing.paused === false) return undefined
	return t.state.type === 'paused' || states.busy(t.state) ? { type: 'continue', sessionId: editing.sessionId } : undefined
}

// The bar over the box during an edit from an Edit button (task 26q),
// without the key hint, which pages with a keyboard add. The newest
// prompt is replaced only if nothing with side effects ran since
// (prompts.amend on the host).
function bar(editing: Editing): string {
	return amend.hint(editing).split(']')[0] + ']'
}

export const amend = {
	hint: (editing?: Editing, text = editing?.original) => {
		if (!editing) return ''
		let waiting = !!editing.queueEdit || (editing.inbox !== undefined && !editing.paused)
		let changed = text !== editing.original
		let label = waiting ? 'editing waiting message' : 'editing prompt'
		if (editing.rewind !== undefined) label += ` #${editing.rewind}`
		let edit = editing.rewind !== undefined ? 'edit and discard later prompts' : 'edit'
		let enter = changed ? `enter: ${waiting ? 'save' : editing.changed ? 'send as new' : edit}, ` : ''
		return `[${label}] ${enter}${changed ? '' : '↓/'}esc: ${waiting ? 'back' : changed ? 'cancel' : 'continue'}`
	},
	step(editing: Editing, t: Transcript, dir: -1 | 1) {
		if (editing.queueEdit) return undefined
		let keys = editable(t.items)
		let list = t.items.filter((i) => mine(i) && keys.has(i.key))
		let atIndex = list.findIndex((i) => i.key === editing.target)
		let item = list[(atIndex < 0 ? list.length : atIndex) + dir]
		let begun = item && at(t, item.key)
		return begun && { ...begun.editing, aside: editing.aside, paused: editing.paused, inbox: undefined }
	},
	editable,
	at,
	bar,
	begin,
	enter,
	resume,
}
