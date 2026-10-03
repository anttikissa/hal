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
// The changes each merged item stands for, for the terminal's rows.
const runs = new WeakMap<Item, Output[]>()

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
			runs.set(hit.merged, run)
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

// Added and removed lines of a change; `text` skips blank ones.
function counts(o: Output): { add: number; del: number; text: string[] } {
	let rows = o.change!.diff.split('\n').filter((r) => r[0] === '+' || r[0] === '-')
	return { add: rows.filter((r) => r[0] === '+').length, del: rows.filter((r) => r[0] === '-').length, text: rows.filter((r) => r.slice(1).trim()) }
}

// A one-line edit as its changed words with a word of context either
// side: 'Apply Strunk → Prunk & …', '… end +now'. Undefined unless the change
// replaces exactly one non-blank line with another.
function edit(o: Output): string | undefined {
	let c = counts(o)
	if (c.add !== 1 || c.del !== 1 || c.text.length !== 2) return undefined
	let a = c.text.find((r) => r[0] === '-')!.slice(1).trim().split(' ')
	let b = c.text.find((r) => r[0] === '+')!.slice(1).trim().split(' ')
	let pre = 0
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
	let suf = 0
	while (suf < a.length - pre && suf < b.length - pre && a.at(-1 - suf) === b.at(-1 - suf)) suf++
	let from = Math.max(0, pre - 1)
	let lead = from > 0 ? '… ' : ''
	let tail = suf > 1 ? ' …' : ''
	let words = (w: string[]) => w.slice(pre, w.length - suf).join(' ')
	let mid = !words(a) ? `+${words(b)}` : !words(b) ? `−${words(a)}` : `${words(a)} → ${words(b)}`
	let before = a.slice(from, pre).join(' '), after = suf ? a[a.length - suf]! : ''
	return [lead + before, mid, after + tail].filter((x) => x.trim()).join(' ')
}

// Plain rows for a terminal, which cannot open a card. One change:
// '11:25 AGENTS.md changed  +2 −0', then up to three changed lines.
// A run: '11:14–11:25 3 changes (one time if both match) to …', then one aligned row per change
// with its first changed line. `tone` picks a row's colour.
type Row = { text: string; tone: 'head' | 'add' | 'del' | 'dim' }
function rows(item: object, now = Date.now()): Row[] {
	let one = item as Output
	let run = runs.get(item as Item) ?? (one.type === 'output' && one.change ? [one] : [])
	if (!run.length) return []
	let tally = (c: ReturnType<typeof counts>) => `+${c.add} −${c.del}`
	let tone = (r: string): Row['tone'] => (r[0] === '+' ? 'add' : 'del')
	let span = (a: Output, b: Output) => (hhmm(a.ts, now) === hhmm(b.ts, now) ? hhmm(a.ts, now) : `${hhmm(a.ts, now)}–${hhmm(b.ts, now)}`)
	let clean = (r: string) => `${r[0]} ${r.slice(1).trim()}`
	if (run.length === 1) {
		let c = counts(run[0]!)
		let out: Row[] = [{ text: `${hhmm(run[0]!.ts, now)} ${summary(run, now)}  ${tally(c)}`, tone: 'head' }]
		let e = edit(run[0]!)
		if (e) return [...out, { text: `  ${e}`, tone: 'dim' }]
		out.push(...c.text.slice(0, 3).map((r) => ({ text: `  ${clean(r)}`, tone: tone(r) })))
		if (c.text.length > 3) out.push({ text: `  … ${c.text.length - 3} more`, tone: 'dim' })
		else if (!c.text.length && c.add + c.del) out.push({ text: '  blank lines only', tone: 'dim' })
		return out
	}
	let names = [...new Set(run.map((o) => o.change!.name))]
	let pad = Math.max(...run.map((o) => o.change!.name.length))
	let out: Row[] = [{ text: `${span(run[0]!, run.at(-1)!)} ${run.length} changes to ${names.join(', ')}`, tone: 'head' }]
	for (let o of run) {
		let c = counts(o)
		let first = c.text[0]
		let e = edit(o)
		let note = [o.change!.what === 'changed' ? '' : o.change!.what, e ?? (first ? clean(first) : c.add + c.del ? 'blank lines' : '')].filter(Boolean).join(' · ')
		out.push({ text: `  ${hhmm(o.ts, now)}  ${o.change!.name.padEnd(pad)}  ${tally(c).padEnd(7)}  ${note}`.trimEnd(), tone: e || !first ? 'dim' : tone(first) })
	}
	return out
}

// The changes a drawn item stands for: a merged run's, or its own.
function run(item: Item): Output[] {
	return runs.get(item) ?? (item.type === 'output' && item.change ? [item as Output] : [])
}

export const promptChanges = { summary, group, hhmm, line, rows, run }
