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
export type Editing = { sessionId: string; original: string; inbox?: string; aside?: true; paused?: boolean; rewind?: number; later?: number; changed?: boolean; queueEdit?: string }

const mine = (i: Item): i is Item & { type: 'prompt' } => i.type === 'prompt' && i.from === undefined && i.origin !== 'model'

// Keys of the prompts the human sent since the latest compaction (a
// clear leaves no items before it): each has an Edit button. A record
// delivering several texts is edited by its first (key `n`).
function editable(items: Item[]): Set<string> {
	let out = new Set<string>()
	for (let i of items) {
		if (i.type === 'divider' && i.text.startsWith('context compacted')) out.clear()
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
	let editing: Editing = { sessionId, original: item.text, aside: true, paused: !!command }
	let after = t.items.slice(i + 1)
	editing.changed = after.some((x) => x.type === 'tool' && !toolDetails.readOnly.has(x.name))
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
	if (t.inbox.some((m) => m.queue && m.from === undefined && m.origin !== 'model')) return undefined
	let waiting = t.inbox.findLast((m) => m.from === undefined && m.origin !== 'model')
	if (waiting) return { editing: { sessionId, original: waiting.text, inbox: waiting.id } }
	if (!states.busy(t.state)) return undefined
	let last = t.items.findLast((i) => i.type === 'prompt' && i.from === undefined && i.origin !== 'model')
	if (last?.type !== 'prompt') return undefined
	return { editing: { sessionId, original: last.text }, command: { type: 'pause', sessionId } }
}

// Enter while editing. Alt-Enter (`queue`) and an emptied editor act as
// they do anywhere: queue a new message, or continue.
function enter(editing: Editing, t: Transcript | undefined, text: string, queue = false): unknown {
	if (editing.queueEdit) return undefined
	if (queue || !text.trim()) return states.enter(editing.sessionId, t?.state ?? { type: 'idle' }, text, queue ? 'queue' : 'steer').command
	if (editing.rewind !== undefined) return { type: 'submit', sessionId: editing.sessionId, text, rewind: editing.rewind }
	let command = { type: 'submit', sessionId: editing.sessionId, text, amend: true }
	return editing.inbox === undefined ? command : { ...command, edits: editing.inbox }
}

// Leaving the edit (Down unchanged, Escape): continue the paused turn,
// or the one whose pause is still on its way; nothing if it ended or
// was never paused (a waiting message was edited).
function resume(editing: Editing, t: Transcript | undefined): unknown {
	if (editing.queueEdit || !t || t.meta.id !== editing.sessionId || editing.inbox !== undefined || editing.paused === false) return undefined
	return t.state.type === 'paused' || states.busy(t.state) ? { type: 'continue', sessionId: editing.sessionId } : undefined
}

// The bar over the box during an edit from an Edit button (task 26q),
// without the key hint, which pages with a keyboard add. The newest
// prompt is replaced only if nothing with side effects ran since
// (prompts.amend on the host).
function bar(editing: Editing): string {
	if (editing.queueEdit) return 'Editing queued message · Saving keeps its place in the queue'
	if (editing.rewind === undefined) return editing.changed ? 'Editing the last prompt · files changed since, so sending adds it as a new prompt' : 'Editing the last prompt · sending replaces it'
	let k = editing.later ?? 0
	let text = `Editing prompt #${editing.rewind} · sending rewinds here: ${k} later message${k === 1 ? '' : 's'} leave${k === 1 ? 's' : ''} the context`
	return editing.changed ? `${text} · files changed since stay as they are` : text
}

export const amend = {
	hint: (editing?: Editing) => (editing?.queueEdit ? 'editing queued message: Enter saves, Down unchanged or Escape cancels' : editing?.inbox === undefined ? 'editing the last prompt: Enter sends it, Down or Escape continues' : 'editing a waiting message: Enter replaces it, Down or Escape keeps it'),
	editable,
	at,
	bar,
	begin,
	enter,
	resume,
}
