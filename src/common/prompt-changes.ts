// Task ar: changes to system-prompt files (SYSTEM.md, its includes,
// AGENTS.md) as transcript output items. Consecutive ones show as one
// card: "3 changes to SYSTEM.md, AGENTS.md since 10:44", the diffs
// inside. Both clients group with this before drawing.

import type { Item } from './transcript.ts'

// `name`: the file as the user knows it (relative to the session's cwd
// when inside it); `what`: changed, added or removed; `diff`: changed
// lines, capped by the host.
export type PromptChange = { name: string; what: 'changed' | 'added' | 'removed'; diff: string }

type Output = Item & { type: 'output' }

// The same run gives the same object, so the terminal's layout cache
// (frame.ts) and the web's keyed rows keep it.
const cache = new WeakMap<Item, { last: Item; count: number; day: string; merged: Item }>()

function hhmm(ts: string | undefined, now = Date.now()): string {
	if (!ts) return ''
	let d = new Date(ts)
	let time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
	return new Date(now).toDateString() === d.toDateString() ? time : `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${time}`
}

// The card's head line.
function summary(list: Output[], now = Date.now()): string {
	let names = [...new Set(list.map((o) => o.change!.name))].join(', ')
	if (list.length === 1) return `${names} ${list[0]!.change!.what === 'changed' ? 'changed' : list[0]!.change!.what === 'added' ? 'added to the system prompt' : 'removed from the system prompt'}`
	return `${list.length} changes to ${names} since ${hhmm(list[0]!.ts, now)}`
}

// Runs of consecutive prompt-change outputs merged into their first:
// its key, the summary as text's first line, then each diff.
function group(items: Item[], now = Date.now()): Item[] {
	let out: Item[] = []
	for (let i = 0; i < items.length; ) {
		let item = items[i]!
		if (item.type !== 'output' || !item.change) { out.push(item); i++; continue }
		let run: Output[] = []
		while (i < items.length && items[i]!.type === 'output' && (items[i] as Output).change) run.push(items[i++] as Output)
		let last = run.at(-1)!
		let hit = cache.get(run[0]!)
		if (hit?.last !== last || hit.count !== run.length || hit.day !== new Date(now).toDateString()) {
			let body = run.map((o) => `${promptChanges.line(o, now)}\n\`\`\`diff\n${o.change!.diff}\n\`\`\``)
			hit = { last, count: run.length, day: new Date(now).toDateString(), merged: { ...item, text: [summary(run, now), ...body].join('\n\n') } }
			cache.set(run[0]!, hit)
		}
		out.push(hit.merged)
	}
	return out
}

// One change's line: '11:14 SYSTEM.md changed (+1 −2)'.
function line(o: Output, now = Date.now()): string {
	let rows = o.change!.diff.split('\n')
	let n = (c: string) => rows.filter((r) => r.startsWith(c)).length
	return `${hhmm(o.ts, now)} ${o.change!.name} ${o.change!.what} (+${n('+')} −${n('-')})`
}

// The lines outside the diffs: the summary and one per change, which
// the terminal shows (it cannot open a card).
function outline(text: string): string {
	let fenced = false
	return text.split('\n').filter((l) => {
		if (l.startsWith('```')) fenced = !fenced
		else if (!fenced && l) return true
		return false
	}).join('\n')
}

export const promptChanges = { summary, group, hhmm, line, outline }
