// The model picker (tasks/w4/forms.md, Model picker): a modal with a
// search box over the host's model ids, ranked as you type. Enter ends
// in an ordinary command, `/model <id>`. Shared by terminal and web;
// the list itself comes from the host (the `models` event).

import type { ModalAction, ModalState } from './modals.ts'
import { modals } from './modals.ts'

// Lowercase words, split at anything not a letter or digit and between
// letters and digits: "Opus-5.5" and "opus5 5" are both opus, 5, 5.
function words(s: string): string[] {
	return s.toLowerCase().match(/[a-z]+|[0-9]+/g) ?? []
}

// How well `id` matches the query words, or undefined if it does not:
// each word must appear, in order, preferably where a word of the id
// starts. Whole words and words right after the previous match score
// higher, so "opus-5.5" prefers claude-opus-5-5 to claude-opus-5-15.
function score(id: string, query: string[]): number | undefined {
	let parts = words(id)
	let text = parts.join(' ')
	let starts = new Set<number>()
	let at = 0
	for (let p of parts) {
		starts.add(at)
		at += p.length + 1
	}
	let total = 0
	let pos = 0
	let lastEnd = -1
	for (let q of query) {
		let found = -1
		for (let i = text.indexOf(q, pos); i >= 0; i = text.indexOf(q, i + 1)) {
			if (found < 0) found = i
			if (starts.has(i)) {
				found = i
				break
			}
		}
		if (found < 0) return undefined
		let end = found + q.length
		if (starts.has(found)) total += 2
		if (starts.has(found) && (end === text.length || text[end] === ' ')) total += 1
		if (lastEnd >= 0 && found === lastEnd + 1) total += 3
		lastEnd = end
		pos = end
	}
	return total
}

// The ids matching `query`, best first; ties keep the given order,
// shorter ids first. An empty query keeps every id in order.
function rank(ids: string[], query: string): string[] {
	let q = words(query)
	if (!q.length) return ids
	let scored: { id: string; score: number; i: number }[] = []
	ids.forEach((id, i) => {
		let s = score(id, q)
		if (s !== undefined) scored.push({ id, score: s, i })
	})
	scored.sort((a, b) => b.score - a.score || a.id.length - b.id.length || a.i - b.i)
	return scored.map((s) => s.id)
}

// The picker over `ids`, on the current model.
function open(current: string, ids: string[]): ModalState {
	let st = modals.open({
		title: `Model: ${current}`,
		hint: 'enter: switch, esc: cancel',
		form: { text: 'Switch model', fields: [{ type: 'text', name: 'search', label: 'Search' }] },
		items: ids,
	})
	return { ...st, selected: Math.max(0, ids.indexOf(current)) }
}

// The list again for what the search box says now.
function refilter(st: ModalState, ids: string[]): ModalState {
	let query = st.form?.values[0] ?? ''
	return { ...st, items: picker.rank(ids, query) }
}

// The command Enter sends: switch the session to the selected model.
function command(sessionId: string, st: ModalState, action: Extract<ModalAction, { type: 'submit' }>): { type: 'submit'; sessionId: string; text: string } | undefined {
	let id = action.item === undefined ? undefined : st.items[action.item]
	return id === undefined ? undefined : { type: 'submit', sessionId, text: `/model ${id}` }
}

export const picker = { rank, open, refilter, command }
