// Shared terminal/web rows and the interactive todo-file format (task 01d).
import { attachments } from './attachments.ts'
import type { UserBlock } from './blocks.ts'
import { rebase, type RebasePlan } from './rebase.ts'
import { replay, type HistoryRecord } from './replay.ts'
import { tokenEstimates } from './token-estimates.ts'

export type RebaseRow = {
	n: number; ns: number[]; ts: string; time: string; kind: string; summary: string
	characters: number; tokens: number; carries: string[]; group: number[]
	editable: boolean; editN?: number; text?: string
}
export type RowOptions = { model?: string; ratios?: Record<string, number>; blobSizes?: Record<string, number>; pruned?: number[] }
export type RebaseRows = { base: number; records: HistoryRecord[]; rows: RebaseRow[]; options: RowOptions }
export type RebaseTotals = { rows: number; tokens: number; after: number; cacheFrom?: number }
export type ParsedTodo = { plan: RebasePlan; queue: string[]; edits: number[]; aborted: boolean }

const oneLine = (text: string) => text.split(/\r?\n/, 1)[0]!.replace(/[\t\x00-\x1f\x7f]/g, ' ').trim()
const size = (n: number) => n < 1000 ? `${n} B` : n < 1e6 ? `${Math.round(n / 100) / 10} kB` : `${Math.round(n / 1e5) / 10} MB`
const kilo = (n: number) => n < 1000 ? String(n) : `${Math.round(n / 100) / 10}k`

function build(raw: HistoryRecord[], options: RowOptions = {}): RebaseRows {
	let records = replay.current(raw), rows: RebaseRow[] = [], groups = rebase.groups(records)
	let calls = new Map<string, RebaseRow>(), command: RebaseRow | undefined
	let byNumber = new Map(records.map((r) => [r.n, r]))
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
				payload(row, [b])
				row.editable = true; row.editN = rebase.text(r) !== undefined ? r.n : row.n; row.text = b.output
				calls.delete(b.id)
			}
		} else if (r.type === 'assistant') {
			let b = r.block
			if (b.type === 'tool_call') {
				let detail = b.input.command ?? b.input.path ?? b.input.description ?? ''
				let row = add(r, b.name, `${b.name === 'bash' ? '$ ' : ''}${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, JSON.stringify(b.input).length)
				calls.set(b.id, row)
			} else {
				let row = add(r, b.type === 'text' ? 'assistant' : 'thinking', b.text, b.text.length)
				carry(row, b.text)
				row.editable = b.type === 'text'; row.editN = row.editable ? r.n : undefined; row.text = row.editable ? b.text : undefined
			}
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
	let header = `# Rebase ${oneLine(sessionId)} · ${sums.rows} rows · ${kilo(sums.tokens)} tokens → ${kilo(sums.after)} after · cache rebuilds ${sums.cacheFrom === undefined ? 'nowhere' : `from #${sums.cacheFrom}`}`
	return [header, "# keep/drop/edit/queue; delete a line = drop; empty file or 'abort' cancels", '# edit opens the full text next; queue lines go last and are sent after', ...snapshot.rows.map((row) => {
		let action = row.ns.some((n) => drops.has(n)) ? 'drop' : row.ns.some((n) => edits.has(n)) ? 'edit' : 'keep'
		return `${action.padEnd(5)} #${row.n}  ${row.time}  ${row.kind}  ${kilo(row.tokens)}  ${row.summary}${row.carries.length ? `  (${row.carries.join('; ')})` : ''}`
	})].join('\n') + '\n'
}

function parse(text: string, snapshot: RebaseRows, replacements: Record<number, string> = {}): ParsedTodo {
	let out: ParsedTodo = { plan: { base: snapshot.base, drop: [], edit: [] }, queue: [], edits: [], aborted: false }
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
		let row = entry!.row
		if (match![1] === 'drop') out.plan.drop.push(...row.ns)
		if (match![1] === 'edit') {
			if (!row.editable || row.editN === undefined) fail(`record #${id} is not editable`)
			if (Object.hasOwn(replacements, id) && typeof replacements[id] !== 'string') fail('replacement must be text')
			if (Object.hasOwn(replacements, id)) out.plan.edit.push({ n: row.editN!, text: replacements[id]! })
			else out.edits.push(id)
		}
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
