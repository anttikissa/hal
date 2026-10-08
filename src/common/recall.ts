// Input history (task 91), shared by the terminal and the web: Up on
// the prompt's top row recalls the previous prompt sent to the session,
// Down on its bottom row the next, and past the newest Down brings back
// the user's own text. The list is the session's prompts as its
// transcript has them, so every client's prompts are in it.
//
// The recalled entry is only shown: the session's draft (drafts.ts)
// stays the user's own text until they edit the entry, which then
// becomes the draft (`typed`) without losing the browsing position.
// Browsing belongs to the session and survives switching sessions.

import { promptLayout } from './prompt-layout.ts'
import type { Transcript } from './transcript.ts'

// While browsing a session: the entry shown and its text.
export type Browse = { index: number; text: string; edited?: true }

export type Shown = { text: string; cursor: number }

// Human prompts sent to the session, oldest first.
function entries(t: Transcript): string[] {
	return t.items.flatMap((i) => (i.type === 'prompt' && i.from === undefined && i.origin !== 'model' ? [i.text] : []))
}

// Where the cursor goes on `text`'s top row: its end, as the rows are
// laid out at `width`.
function topEnd(text: string, width: number): number {
	return promptLayout.offsetAt(text, promptLayout.rows(text, width), 0, Infinity)
}

// Up (-1) or Down (1) with the cursor at `cursor` in `text`: what to
// show instead, or undefined when the key is not history's (the cursor
// is not on the edge row, or there is nothing to go to) and moves the
// cursor as usual. `list`: the session's entries; `draft`: the user's
// own text, shown again past the newest entry. `width`: the layout's
// width, Infinity for logical lines.
function step(id: string, list: string[], text: string, cursor: number, dir: -1 | 1, width: number, draft: string): Shown | undefined {
	let rows = promptLayout.rows(text, width)
	let { row } = promptLayout.position(text, rows, cursor)
	if (dir < 0 ? row > 0 : row < rows.length - 1) return undefined
	let st = recall.state
	let b = st.get(id)
	let index = Math.min(b?.index ?? list.length, list.length)
	if (dir < 0) {
		// The prompt just sent may still be in the editor (an edit of
		// it): the first Up skips it.
		if (!b && list[index - 1] === text) index--
		if (index <= 0) return undefined
		index--
		let entry = list[index]!
		st.set(id, { index, text: entry })
		return { text: entry, cursor: entry.length }
	}
	if (!b) return undefined
	index++
	let next = index < list.length ? list[index]! : undefined
	if (next === undefined) st.delete(id)
	else st.set(id, { index, text: next })
	let shown = next ?? draft
	return { text: shown, cursor: recall.topEnd(shown, width) }
}

// The editor now says `text`: true if that is the user's own (to keep
// as the draft), false while it still shows a recalled entry untouched.
// Editing keeps the position, and the edited text becomes the draft.
function typed(id: string, text: string): boolean {
	let b = recall.state.get(id)
	if (!b) return true
	if (b.text === text) return !!b.edited
	b.text = text
	b.edited = true
	return true
}

// The recalled entry the session shows, if browsing.
function shown(id: string): string | undefined {
	return recall.state.get(id)?.text
}

// Ends browsing (a prompt was sent). True if it was browsing.
function stop(id: string): boolean {
	return recall.state.delete(id)
}

function reset(): void {
	recall.state = new Map()
}

export const recall = {
	state: new Map<string, Browse>(),
	entries,
	topEnd,
	step,
	typed,
	shown,
	stop,
	reset,
}
