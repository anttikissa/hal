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
// shorter ids first. An empty query keeps every id in order. An id's
// display name in `names` matches too, after the id itself.
function rank(ids: string[], query: string, names: Record<string, string> = {}): string[] {
	let q = words(query)
	if (!q.length) return ids
	let scored: { id: string; score: number; i: number }[] = []
	ids.forEach((id, i) => {
		let s = score(names[id] ? `${id} ${names[id]}` : id, q)
		if (s !== undefined) scored.push({ id, score: s, i })
	})
	scored.sort((a, b) => b.score - a.score || a.id.length - b.id.length || a.i - b.i)
	return scored.map((s) => s.id)
}

// Group the unfiltered picker by provider and family. Group headings are
// selectable: Enter chooses the newest listed member of that family.
function grouped(ids: string[], names: Record<string, string> = {}): { items: string[]; choices: Record<string, string> } {
	let groups = new Map<string, Map<string, string[]>>()
	for (let id of ids) {
		let slash = id.indexOf('/')
		if (slash < 0) continue
		let provider = id.slice(0, slash)
		let model = id.slice(slash + 1).split('/').at(-1)!
		let family = /(?:^|[-/])(opus|sonnet|haiku|gpt|kimi|qwen|deepseek|glm|minimax)(?:[-\d.]|$)/i.exec(model)?.[1]?.toLowerCase() ?? model.split(/[-.]/)[0]!
		let byFamily = groups.get(provider) ?? new Map<string, string[]>()
		if (!groups.has(provider)) groups.set(provider, byFamily)
		byFamily.set(family, [...(byFamily.get(family) ?? []), id])
	}
	let items: string[] = []
	let choices: Record<string, string> = {}
	let newest = new Intl.Collator('en', { numeric: true })
	for (let [provider, families] of groups) {
		let all = [...families.values()].flat()
		let header = `${provider}/  (${all.length} models)`
		items.push(header)
		choices[header] = all[0]!
		for (let [family, members] of families) {
			let preferred = [...members].sort((a, b) => newest.compare(b, a))[0]!
			let row = `  ${provider}/${family}  (default: ${preferred.slice(provider.length + 1)})`
			items.push(row)
			choices[row] = preferred
			for (let id of members) {
				let label = `    ${id}${names[id] ? ` · ${names[id]}` : ''}${id === preferred ? '  ← default' : ''}`
				items.push(label)
				choices[label] = id
			}
		}
	}
	return { items, choices }
}
// The picker over `ids`, on the current model.
function open(current: string, ids: string[], names: Record<string, string> = {}): ModalState {
	let { items, choices } = picker.grouped(ids, names)
	let st = modals.open({
		title: `Model: ${current}`,
		hint: 'enter: switch, esc: cancel',
		form: { text: 'Switch model', fields: [{ type: 'text', name: 'search', label: 'Search' }] },
		items,
	})
	return { ...st, choices, selected: Math.max(0, items.findIndex((item) => choices[item] === current && item.startsWith('    '))) }
}

// The list again for what the search box says now.
function refilter(st: ModalState, ids: string[], names?: Record<string, string>): ModalState {
	let query = st.form?.values[0] ?? ''
	return query ? { ...st, items: picker.rank(ids, query, names) } : { ...st, ...picker.grouped(ids, names) }
}

// The command Enter sends: switch the session to the selected model.
function command(sessionId: string, st: ModalState, action: Extract<ModalAction, { type: 'submit' }>): { type: 'submit'; sessionId: string; text: string } | undefined {
	let row = action.item === undefined ? undefined : st.items[action.item]
	let id = row === undefined ? undefined : st.choices?.[row] ?? row
	return id === undefined ? undefined : { type: 'submit', sessionId, text: `/model ${id}` }
}

export const picker = { rank, grouped, open, refilter, command }
