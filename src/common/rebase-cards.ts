// Display-only rebase runs shared by both clients. Original items, keys,
// reports and errors remain intact; no stored history or undo is changed.
// Tasks: 18n.
import type { Item, Shown } from './transcript.ts'
import { titles } from './titles.ts'
import { toolDetails } from './tool-details.ts'

const cache = new WeakMap<Item, { run: Item[]; merged: Item }>()

function starts(item: Shown): boolean {
	if (item.type === 'divider') return /^History rewrit(?:ten|e undone)/.test(item.text)
	if (item.type === 'command') return /^\/rebase(?:\s|$)/.test(item.text) && !/^\/rebase\s+show\s*$/.test(item.text)
	if (item.type === 'output') return /^(?:Rebase (?:applied[.( ]|failed:|preview;|undone\.|unchanged\.|aborted\.)|\/rebase (?:accepted;|applied\.|canceled;))/.test(item.text)
	return item.type === 'tool' && item.name === 'command' && typeof item.input.command === 'string' && /^\s*\/rebase(?:\s|$)/.test(item.input.command) && !/^\s*\/rebase\s+show\s*$/.test(item.input.command)
}

function members(item: Shown): Item[] {
	return item.type === 'output' ? item.rebaseReports ?? [] : []
}

function group(items: Item[]): Item[] {
	let out: Item[] = []
	// Running tools retain their native streaming card until their result arrives.
	let completed = new Set(items.flatMap((i) => i.type === 'tool-result' ? [i.id] : []))
	let ready = (i: Item) => rebaseCards.starts(i) && (i.type !== 'tool' || completed.has(i.id))
	for (let i = 0; i < items.length;) {
		let first = items[i]!
		if (!ready(first)) { out.push(first); i++; continue }
		let run: Item[] = [], calls = new Set<string>(), command = false
		while (i < items.length) {
			let item = items[i]!
			let follows = item.type === 'output' && command && !item.change
			let result = item.type === 'tool-result' && calls.has(item.id)
			if (!ready(item) && !follows && !result) break
			run.push(item); i++
			if (item.type === 'command') command = true
			else if (item.type === 'output') command = false
			if (item.type === 'tool') calls.add(item.id)
		}
		let hit = cache.get(first)
		if (!hit || hit.run.length !== run.length || run.some((item, n) => hit!.run[n] !== item)) {
			let error = run.some((item) => (item.type === 'output' && item.error) || (item.type === 'tool-result' && item.isError))
			let reports = run.filter((item) => item.type === 'divider' || item.type === 'output' || item.type === 'tool-result')
			let latest = reports.at(-1)
			let status = latest && (latest.type === 'tool-result' ? latest.output : 'text' in latest ? latest.text : '')
			let brief = status?.split('\n')[0] ?? 'pending'
			let rewrites = run.filter((i) => i.type === 'divider' && i.text.startsWith('History rewritten ·')).length
			let text = `${brief}${rewrites > 1 ? ` · ${rewrites} rewrites` : ''}${error ? ' · error' : ''}`
			let merged: Item = { type: 'output', key: first.key, ts: first.ts, text, rebaseReports: run, ...(error && { error: true }) }
			hit = { run, merged }; cache.set(first, hit)
		}
		out.push(hit.merged)
	}
	return out
}

function detail(item: Item): string {
	let text = item.type === 'tool' ? [String(item.input.command ?? ''), ...Object.entries(item.input).filter(([key]) => key !== 'command').flatMap(([key, value]) => [`${key}: ${toolDetails.value(value).join('\n')}`])].join('\n')
		: item.type === 'tool-result' ? item.output : 'text' in item ? item.text : ''
	return `${titles.time(item.ts)} #${titles.blockId(item)}\n${text}`
}

function undo(item: Shown): boolean {
	return rebaseCards.members(item).some((i) => i.type === 'divider' && i.text.startsWith('History rewritten · /rebase undo ·'))
}

export const rebaseCards = { starts, members, group, detail, undo }
