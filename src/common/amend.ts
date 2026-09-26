// Editing the last prompt while the model works (tasks/j1/states.md),
// the part every client shares: Up on an empty prompt pauses the turn
// and loads the last prompt into the editor; Enter sends the edit, and
// the host decides from history whether it replaces that prompt (only
// reading happened since) or goes on top (something changed). Down with
// the text unchanged, or Escape, continues the paused turn.

import { states } from './states.ts'
import type { Transcript } from './transcript.ts'

// An edit in progress: of which session's prompt, and its text then.
export type Editing = { sessionId: string; original: string }

// Up with `text` in the editor: the edit to start and the pause to
// send, or undefined when Up means nothing here.
function begin(t: Transcript | undefined, text: string): { editing: Editing; command: unknown } | undefined {
	if (!t || text !== '' || !states.busy(t.state)) return undefined
	let last = t.items.findLast((i) => i.type === 'prompt')
	if (last?.type !== 'prompt') return undefined
	let sessionId = t.meta.id
	return { editing: { sessionId, original: last.text }, command: { type: 'pause', sessionId } }
}

// Enter while editing. Alt-Enter (`queue`) and an emptied editor act as
// they do anywhere: queue a new message, or continue.
function enter(editing: Editing, t: Transcript | undefined, text: string, queue = false): unknown {
	if (queue || !text.trim()) return states.enter(editing.sessionId, t?.state ?? { type: 'idle' }, text, queue).command
	return { type: 'submit', sessionId: editing.sessionId, text, amend: true }
}

// Leaving the edit (Down unchanged, Escape): continue the paused turn,
// or the one whose pause is still on its way; nothing if it ended.
function resume(editing: Editing, t: Transcript | undefined): unknown {
	if (!t || t.meta.id !== editing.sessionId) return undefined
	return t.state.type === 'paused' || states.busy(t.state) ? { type: 'continue', sessionId: editing.sessionId } : undefined
}

export const amend = {
	hint: () => 'editing the last prompt: Enter sends it, Down or Escape continues',
	begin,
	enter,
	resume,
}
