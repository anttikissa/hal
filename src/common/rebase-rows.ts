// Shared terminal/web rows and the interactive todo-file format (tasks 01d, svt).
import { inbox } from './inbox.ts'
import { attachments } from './attachments.ts'
import type { UserBlock } from './blocks.ts'
import { rebase, type RebasePlan } from './rebase.ts'
import { replay, type HistoryRecord } from './replay.ts'
import { tokenEstimates } from './token-estimates.ts'

export type RebaseRow = {
	n: number; ns: number[]; ts: string; time: string; kind: string; summary: string
	characters: number; tokens: number; carries: string[]; group: number[]
	editable: boolean; tool?: true; editN?: number; text?: string
}
export type RowOptions = { model?: string; ratios?: Record<string, number>; blobSizes?: Record<string, number>; pruned?: number[] }
export type RebaseRows = { paused?: true; base: number; records: HistoryRecord[]; rows: RebaseRow[]; options: RowOptions }
export type RebaseTotals = { rows: number; tokens: number; after: number; cacheFrom?: number }
export type ParsedTodo = { plan: RebasePlan; queue: string[]; edits: number[]; aborted: boolean; inline: Record<number, string> }

const oneLine = (text: string) => text.split(/\r?\n/, 1)[0]!.replace(/[\t\x00-\x1f\x7f]/g, ' ').trim()
const size = (n: number) => n < 1000 ? `${n} B` : n < 1e6 ? `${Math.round(n / 100) / 10} kB` : `${Math.round(n / 1e5) / 10} MB`
const kilo = (n: number) => n < 1000 ? String(n) : `${Math.round(n / 100) / 10}k`
// Rows whose summary is their editable text's first line, maybe after a sender label.
const inlineKinds = new Set(['prompt', 'assistant', 'queued', 'advisory', 'interjecting', 'steering'])
const columns = (row: RebaseRow) => [`#${row.n}`, row.time, row.kind, kilo(row.tokens)]
const carried = (row: RebaseRow) => row.carries.length ? `(${row.carries.join('; ')})` : ''
const words = (text: string) => text.trim().split(/\s+/).join(' ')

function build(raw: HistoryRecord[], options: RowOptions = {}): RebaseRows {
	let records = replay.current(raw), rows: RebaseRow[] = [], groups = rebase.groups(records)
	let calls = new Map<string, RebaseRow>(), command: RebaseRow | undefined
	let byNumber = new Map(records.map((r) => [r.n, r]))
	let waiting = new Map(inbox.pending(records).map((item) => [item.n, item]))
	let revisions = new Map<string, number[]>()
	for (let r of records) if (r.type === 'inbox' && r.n !== undefined) {
		let ns = revisions.get(r.id) ?? []
		ns.push(r.n); revisions.set(r.id, ns)
	}
	let add = (r: HistoryRecord, kind: string, summary: string, characters: number): RebaseRow => {
		if (r.n === undefined) throw new Error('Rebase rows require stable record numbers.')
		let row: RebaseRow = { n: r.n, ns: [r.n], ts: r.ts, time: '', kind, summary: oneLine(summary), characters, tokens: 0, carries: [], group: [...(groups.get(r.n) ?? [r.n])], editable: false }
		rows.push(row)
		return row
	}
	let carry = (row: RebaseRow, text: string) => {
		let ids = new Set(attachments.markers(text).filter((m) => m.kind !== 'image').map((m) => m.blob))
		for (let m of text.matchAll(/whole output in blob ([0-9a-f]{12}|[0-9a-z]{6})/g)) ids.add(m[1]!)
		for (let id of ids) {
			let bytes = options.blobSizes?.[id]
			row.carries.push(`blob ${id}${bytes === undefined ? '' : ` ${size(bytes)}`}`)
			if (bytes !== undefined && attachments.markers(text).some((m) => m.blob === id && m.kind !== 'image')) row.characters += bytes
		}
		if (/whole output in blob|\[.*(?:cut|truncated)/i.test(text)) row.carries.push('output cut')
		if (/\[pruned /.test(text)) row.carries.push('pruned')
	}
	let payload = (row: RebaseRow, blocks: UserBlock[]) => {
		let images = blocks.flatMap((b) => b.type === 'image' ? [b] : b.type === 'tool_result' && b.image ? [b.image] : [])
		if (images.length) row.carries.push(`${images.length} image${images.length === 1 ? '' : 's'}`)
		for (let image of images) row.characters += image.bytes ?? options.blobSizes?.[image.blob] ?? 0
		for (let b of blocks) if (b.type === 'text') carry(row, b.text); else if (b.type === 'tool_result') carry(row, b.output)
	}
	for (let r of records) {
		if (r.type === 'user') {
			let texts = r.blocks.filter((b) => b.type === 'text')
			if (texts.length || r.blocks.some((b) => b.type === 'image')) {
				command = undefined
				let text = texts.map((b) => b.text).join('\n\n')
				let row = add(r, 'prompt', text || 'Image prompt', text.length)
				payload(row, r.blocks.filter((b) => b.type !== 'tool_result'))
				row.editable = texts.length > 0; row.editN = row.editable ? r.n : undefined; row.text = row.editable ? text : undefined
			}
			for (let b of r.blocks) if (b.type === 'tool_result') {
				let row = calls.get(b.id)
				if (!row) continue // orphan results are not provider input
				if (!row.ns.includes(r.n!)) row.ns.push(r.n!)
				row.characters += b.output.length
				if (!row.summary) row.summary = oneLine(b.output)
				payload(row, [b])
				row.editable = true; row.editN = rebase.text(r) !== undefined ? r.n : row.n; row.text = b.output
				calls.delete(b.id)
			}
		} else if (r.type === 'assistant') {
			let b = r.block
			if (b.type === 'tool_call') {
				let detail = b.input.command ?? b.input.path ?? b.input.description ?? Object.entries(b.input).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
				let row = add(r, b.name, `${b.name === 'bash' ? '$ ' : ''}${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, JSON.stringify(b.input).length)
				row.tool = true
				calls.set(b.id, row)
			} else {
				let row = add(r, b.type === 'text' ? 'assistant' : 'thinking', b.text, b.text.length)
				carry(row, b.text)
				row.editable = b.type === 'text'; row.editN = row.editable ? r.n : undefined; row.text = row.editable ? b.text : undefined
			}
		} else if (r.type === 'inbox' && waiting.has(r.n)) {
			let item = waiting.get(r.n)!
			let kind = item.queue ? 'queued' : item.advisory ? 'advisory' : item.interject ? 'interjecting' : 'steering'
			let row = add(r, kind, `${item.from === undefined ? 'You' : item.label ?? item.from}: ${item.text}`, item.text.length)
			row.ns = revisions.get(r.id)!
			row.editable = true; row.editN = row.ns.at(-1); row.text = item.text
			carry(row, item.text)
		} else if (r.type === 'command') command = add(r, 'command', r.text, r.text.length)
		else if (r.type === 'output') {
			if (!command) { let row = add(r, 'output', r.text, r.text.length); carry(row, r.text) }
			else { command.ns.push(r.n!); command.characters += r.text.length; carry(command, r.text) }
		} else if (r.type === 'compact' || r.type === 'reset') {
			add(r, r.type, r.type === 'compact' ? r.summary : 'Context cleared', r.type === 'compact' ? r.summary.length : 0)
			command = undefined
		}
	}
	let previous: string | undefined
	for (let row of rows) {
		row.time = replay.clock(row.ts, previous); previous = row.ts
		row.group = [...new Set(row.ns.flatMap((n) => [...(groups.get(n) ?? [n])]))]
		if (row.group.some((n) => !row.ns.includes(n) && byNumber.has(n))) row.carries.push(`drop group ${row.group.map((n) => `#${n}`).join(', ')}`)
		if (row.ns.some((n) => options.pruned?.includes(n)) && !row.carries.includes('pruned')) row.carries.push('pruned')
		row.tokens = tokenEstimates.estimate(row.characters, options.model, options.ratios)
	}
	return { base: raw.at(-1)?.n ?? 0, records, rows, options }
}

function totals(snapshot: RebaseRows, plan: RebasePlan = { base: snapshot.base, drop: [], edit: [] }): RebaseTotals {
	let after = rebaseRows.build(rebase.apply(snapshot.records, plan), snapshot.options)
	let groups = rebase.groups(snapshot.records)
	let changed = new Set(plan.drop.flatMap((n) => [...(groups.get(n) ?? [n])]))
	for (let e of plan.edit) {
		let row = snapshot.rows.find((r) => r.editN === e.n)
		if (row?.text !== e.text) changed.add(row && row.n === e.n && row.ns.length > 1 ? row.ns[1]! : e.n)
	}
	return { rows: snapshot.rows.length, tokens: snapshot.rows.reduce((n, r) => n + r.tokens, 0), after: after.rows.reduce((n, r) => n + r.tokens, 0), cacheFrom: snapshot.records.find((r) => changed.has(r.n!))?.n }
}

function render(sessionId: string, snapshot: RebaseRows, plan: RebasePlan = { base: snapshot.base, drop: [], edit: [] }): string {
	let sums = rebaseRows.totals(snapshot, plan)
	let edits = new Set(plan.edit.map((e) => e.n)), drops = new Set(plan.drop)
	let widths = [4, ...['n', 'time', 'kind'].map((key) => Math.max(...snapshot.rows.map((row) => String(row[key as 'n' | 'time' | 'kind']).length + (key === 'n' ? 1 : 0)), 0)), Math.max(...snapshot.rows.map((row) => kilo(row.tokens).length), 0)]
	let header = `# Rebase ${oneLine(sessionId)} · ${sums.rows} rows · ${kilo(sums.tokens)} tokens → ${kilo(sums.after)} after · cache rebuilds ${sums.cacheFrom === undefined ? 'nowhere' : `from #${sums.cacheFrom}`}`
	return [header, "# keep/drop/edit/queue; delete a line = drop; empty file or 'abort' cancels", '# edit opens the full text next; queue lines go last and are sent after', ...snapshot.rows.map((row) => {
		let action = row.ns.some((n) => drops.has(n)) ? 'drop' : row.ns.some((n) => edits.has(n)) ? 'edit' : 'keep'
		return [action, ...columns(row)].map((text, i) => text.padEnd(widths[i]!)).join('  ') + `  ${row.summary}${row.carries.length ? `  ${carried(row)}` : ''}`
	})].join('\n') + '\n'
}

// A changed summary on a keep or edit line edits the text's first line
// (task qb1). `rest` is the line after the action; returns the new full
// text, or undefined when the line says nothing new.
function inline(row: RebaseRow, rest: string): string | undefined {
	let before = [...columns(row), row.summary, carried(row)].join(' ')
	if (!rest || words(rest) === words(before) || words(rest) === `#${row.n}`) return undefined
	let first = oneLine(row.text ?? ''), label = row.summary.slice(0, row.summary.length - first.length)
	let head = new RegExp(`^${columns(row).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('\\s+')}(?:\\s+|$)`).exec(rest)
	let summary = head && rest.slice(head[0].length).trim()
	if (summary !== null && carried(row) && summary.endsWith(carried(row))) summary = summary.slice(0, -carried(row).length).trim()
	if (!row.editable || !inlineKinds.has(row.kind) || row.text === undefined || !row.summary.endsWith(first) || summary === null || !summary.startsWith(label)) throw new Error(`#${row.n} changed, but only the text after the kind and token columns of a prompt, assistant or inbox row can be edited inline; use edit for the rest`)
	let text = summary.slice(label.length).trim()
	return text === first ? undefined : row.text.replace(/^[^\n]*/, () => text)
}

function parse(text: string, snapshot: RebaseRows, replacements: Record<number, string> = {}): ParsedTodo {
	let out: ParsedTodo = { plan: { base: snapshot.base, drop: [], edit: [] }, queue: [], edits: [], aborted: false, inline: {} }
	let active = text.split(/\r?\n/).map((line, i) => ({ line: line.trim(), n: i + 1 })).filter(({ line }) => line && !line.startsWith('#'))
	if (!active.length || active.some(({ line }) => line === 'abort')) { out.aborted = true; return out }
	let seen = new Set<number>(), last = -1, queued = false
	let rows = new Map(snapshot.rows.map((row, i) => [row.n, { row, i }]))
	for (let { line, n } of active) {
		let fail = (message: string): never => { throw new Error(`Rebase line ${n}: ${message}: ${line}`) }
		let queue = /^queue\s+(.+)$/.exec(line)
		if (queue) { out.queue.push(queue[1]!); queued = true; continue }
		if (queued) fail('queue lines must go last')
		let match = /^(keep|pick|drop|edit)\s+#([1-9]\d*)(?:\s|$)/.exec(line)
		if (!match) fail('expected keep, pick, drop, edit or queue')
		let id = Number(match![2]), entry = rows.get(id)
		if (!entry) fail(`unknown record #${id}`)
		if (seen.has(id)) fail(`duplicate record #${id}`)
		if (entry!.i < last) fail('reordering history is refused')
		seen.add(id); last = entry!.i
		let row = entry!.row, changed: string | undefined
		if (match![1] === 'drop') { out.plan.drop.push(...row.ns); continue }
		try { changed = inline(row, line.slice(match![1]!.length).trim()) } catch (error) { fail((error as Error).message) }
		if (changed !== undefined) out.inline[id] = changed
		if (match![1] === 'edit') {
			if (!row.editable || row.editN === undefined) fail(`record #${id} is not editable`)
			if (Object.hasOwn(replacements, id) && typeof replacements[id] !== 'string') fail('replacement must be text')
			if (Object.hasOwn(replacements, id)) out.plan.edit.push({ n: row.editN!, text: replacements[id]! })
			else out.edits.push(id)
		} else if (changed !== undefined) out.plan.edit.push({ n: row.editN!, text: changed })
	}
	for (let row of snapshot.rows) if (!seen.has(row.n)) out.plan.drop.push(...row.ns)
	out.plan.drop = [...new Set(out.plan.drop)]
	let dropped = new Set(out.plan.drop.flatMap((n) => [...(rebase.groups(snapshot.records).get(n) ?? [n])]))
	for (let id of [...out.edits, ...out.plan.edit.map((e) => snapshot.rows.find((r) => r.editN === e.n)!.n)]) {
		let row = rows.get(id)!.row
		if (dropped.has(row.editN!)) {
			let line = active.find((a) => new RegExp(`^edit\\s+#${id}(?:\\s|$)`).test(a.line))!
			throw new Error(`Rebase line ${line.n}: edited record #${id} belongs to a dropped group: ${line.line}`)
		}
	}
	return out
}

export const rebaseRows = { build, totals, render, parse }
