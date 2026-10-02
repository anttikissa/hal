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
import type { Transcript } from './transcript.ts'

// An edit in progress: of which session's message, its text then, and
// `inbox`: the id of the waiting message edited, if it is one.
export type Editing = { sessionId: string; original: string; inbox?: string }

// Up with `text` in the editor: the edit to start and the pause to
// send (none for a waiting message), or undefined when Up means
// nothing here.
function begin(t: Transcript | undefined, text: string): { editing: Editing; command?: unknown } | undefined {
	if (!t || text !== '') return undefined
	let sessionId = t.meta.id
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
	if (queue || !text.trim()) return states.enter(editing.sessionId, t?.state ?? { type: 'idle' }, text, queue).command
	let command = { type: 'submit', sessionId: editing.sessionId, text, amend: true }
	return editing.inbox === undefined ? command : { ...command, edits: editing.inbox }
}

// Leaving the edit (Down unchanged, Escape): continue the paused turn,
// or the one whose pause is still on its way; nothing if it ended or
// was never paused (a waiting message was edited).
function resume(editing: Editing, t: Transcript | undefined): unknown {
	if (!t || t.meta.id !== editing.sessionId || editing.inbox !== undefined) return undefined
	return t.state.type === 'paused' || states.busy(t.state) ? { type: 'continue', sessionId: editing.sessionId } : undefined
}

export const amend = {
	hint: (editing?: Editing) => (editing?.inbox === undefined ? 'editing the last prompt: Enter sends it, Down or Escape continues' : 'editing a waiting message: Enter replaces it, Down or Escape keeps it'),
	begin,
	enter,
	resume,
}
