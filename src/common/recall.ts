// Input history (task 91), shared by the terminal and the web: Up on
// the prompt's top row recalls the previous prompt sent to the session,
// Down on its bottom row the next, and past the newest Down brings back
// the user's own text. The list is the session's prompts as its
// transcript has them, so every client's prompts are in it.
//
// The recalled entry is only shown: the session's draft (drafts.ts)
// stays the user's own text. Edits to any recalled entry are saved on
// that prompt's slot until a message is sent, so stepping away and back
// restores them without overwriting the draft.
// Browsing belongs to the session and survives switching sessions.

import { promptLayout } from './prompt-layout.ts'
import { literal } from './literal.ts'
import { drafts } from './drafts.ts'
import type { Transcript } from './transcript.ts'

export type RecallItem = { key: string; text: string }

// While browsing a session: the entry shown, its slot key and original text.
export type Browse = { index: number; key: string; original: string; text: string }

export type Shown = { text: string; cursor: number }

// Human prompts and slash commands sent to the session, oldest first,
// then those sent and not acknowledged yet; prompts escaped to send as
// prompts again.
function items(t: Transcript): RecallItem[] {
	return [
		...t.items.flatMap((i) =>
			((i.type === 'prompt' && i.origin !== 'model') || i.type === 'command') && i.from === undefined
				? [{ key: i.key, text: i.type === 'prompt' ? literal.escape(i.text) : i.text }]
				: [],
		),
		...drafts.pending(t.meta.id).map((s) => ({ key: s.id, text: s.text })),
	]
}

function entries(t: Transcript): string[] {
	return recall.items(t).map((i) => i.text)
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
function step(
	id: string,
	list: (string | RecallItem)[],
	text: string,
	cursor: number,
	dir: -1 | 1,
	width: number,
	draft: string,
): Shown | undefined {
	let rows = promptLayout.rows(text, width)
	let { row } = promptLayout.position(text, rows, cursor)
	if (dir < 0 ? row > 0 : row < rows.length - 1) return undefined
	let st = recall.state
	let b = st.get(id)
	let entry = (i: number): RecallItem => {
		let x = list[i]!
		return typeof x === 'string' ? { key: String(i), text: x } : x
	}
	let at = b ? list.findIndex((x, i) => (typeof x === 'string' ? String(i) : x.key) === b.key) : -1
	let index = b ? (at >= 0 ? at : Math.min(b.index, list.length)) : list.length
	if (dir < 0) {
		// The prompt just sent may still be in the editor: the first Up skips it
		// unless that slot has unsent edits waiting to be returned to.
		if (!b && index > 0 && entry(index - 1).text === text && drafts.slot(id, entry(index - 1).key) === undefined)
			index--
		if (index <= 0) return undefined
		if (b) drafts.saveSlot(id, b.key, text, b.original)
		index--
		let item = entry(index)
		let shown = drafts.slot(id, item.key) ?? item.text
		st.set(id, { index, key: item.key, original: item.text, text: shown })
		return { text: shown, cursor: shown.length }
	}
	if (!b) return undefined
	drafts.saveSlot(id, b.key, text, b.original)
	index++
	if (index < list.length) {
		let item = entry(index)
		let shown = drafts.slot(id, item.key) ?? item.text
		st.set(id, { index, key: item.key, original: item.text, text: shown })
		return { text: shown, cursor: recall.topEnd(shown, width) }
	}
	st.delete(id)
	return { text: draft, cursor: recall.topEnd(draft, width) }
}

// The editor now says `text`: true if that is the user's own draft
// (not browsing), false while browsing (saved per slot instead of
// overwriting the draft).
function typed(id: string, text: string): boolean {
	let b = recall.state.get(id)
	if (!b) return true
	b.text = text
	drafts.saveSlot(id, b.key, text, b.original)
	return false
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
	items,
	entries,
	topEnd,
	step,
	typed,
	shown,
	stop,
	reset,
}
