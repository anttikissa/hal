// Append-only context surgery. Numbers refer to records, never positions.
import type { HistoryRecord } from './replay.ts'
import { ason } from './ason.ts'
import { modelNotices } from './model-notices.ts'

export type RebasePlan = { base: number; drop: number[]; edit: { n: number; text: string }[] }

function invalid(value: unknown): string | undefined {
	let p = value as RebasePlan
	let number = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0
	if (!p || !Number.isSafeInteger(p.base) || p.base < 0 || !Array.isArray(p.drop) || !Array.isArray(p.edit)) return 'invalid rebase plan'
	if (p.drop.some((n) => !number(n)) || p.edit.some((e) => !e || !number(e.n) || typeof e.text !== 'string')) return 'invalid rebase target'
	if (new Set(p.drop).size !== p.drop.length || new Set(p.edit.map((e) => e.n)).size !== p.edit.length) return 'duplicate rebase target'
	if (p.edit.some((e) => p.drop.includes(e.n))) return 'rebase target is both dropped and edited'
}

// Connected components: a result record may contain several calls' results.
// Signed thinking and the rest of its provider round must stay together.
function groups(records: HistoryRecord[]): Map<number, Set<number>> {
	let out = new Map<number, Set<number>>()
	for (let r of records) if (r.n !== undefined) out.set(r.n, new Set([r.n]))
	let join = (ns: number[]) => {
		let all = new Set(ns.flatMap((n) => [...(out.get(n) ?? [])]))
		for (let n of all) out.set(n, all)
	}
	let inboxRecords = new Map<string, number[]>()
	for (let r of records) if (r.type === 'inbox' && r.n !== undefined) {
		let ns = inboxRecords.get(r.id) ?? []
		ns.push(r.n); inboxRecords.set(r.id, ns)
	}
	for (let ns of inboxRecords.values()) join(ns)
	for (let r of records) if (r.type === 'user' && r.n !== undefined) {
		for (let id of r.inbox ?? []) join([r.n, ...(inboxRecords.get(id) ?? [])])
	}
	let calls = new Map<string, number>(), round: number[] = [], signed = false, command: number | undefined
	let flush = () => { if (signed) join(round); round = []; signed = false }
	for (let r of records) {
		if (r.type === 'assistant' && r.n !== undefined) {
			round.push(r.n)
			if (r.block.type === 'thinking' && (r.block.signature || r.block.signatureBlob)) signed = true
			if (r.block.type === 'tool_call') calls.set(r.block.id, r.n)
		} else if (r.type === 'user') {
			flush()
			for (let b of r.blocks) if (b.type === 'tool_result') {
				let n = calls.get(b.id)
				if (n !== undefined && r.n !== undefined) join([n, r.n])
				calls.delete(b.id)
			}
			if (r.blocks.some((b) => b.type === 'text')) { calls.clear(); command = undefined }
		} else if (r.type === 'command') command = r.n
		else if (r.type === 'output' && !r.change && command !== undefined && r.n !== undefined) join([command, r.n])
		else if (r.type === 'round' || r.type === 'turn_end' || r.type === 'compact' || r.type === 'reset') flush()
	}
	flush()
	return out
}

function text(r: HistoryRecord): string | undefined {
	if (r.type === 'inbox' || r.type === 'notice' || (r.type === 'output' && r.change)) return r.text
	if (r.type === 'change') return ason.stringify(Object.fromEntries(['cwd', 'model', 'autoclose'].filter((k) => Object.hasOwn(r, k)).map((k) => [k, r[k as 'cwd' | 'model' | 'autoclose']])), 'short')
	if (r.type === 'assistant' && r.block.type === 'text') return r.block.text
	if (r.type !== 'user') return undefined
	let texts = r.blocks.filter((b) => b.type === 'text')
	if (texts.length) return texts.map((b) => b.text).join('\n\n')
	if (r.blocks.length === 1 && r.blocks[0]?.type === 'tool_result') return r.blocks[0].output
}

function edited(r: HistoryRecord, text: string): HistoryRecord {
	if (r.type === 'inbox' || r.type === 'notice' || (r.type === 'output' && r.change)) return { ...r, text }
	if (r.type === 'change') {
		let value = ason.parse(text) as Record<string, unknown>
		if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.entries(value).some(([key, v]) => !['cwd', 'model', 'autoclose'].includes(key) || typeof v !== (key === 'autoclose' ? 'boolean' : 'string') || (typeof v === 'string' && !v.trim()))) throw new Error(`record #${r.n}: invalid session setting change`)
		let { cwd: _cwd, model: _model, autoclose: _autoclose, ...rest } = r
		return { ...rest, ...value } as HistoryRecord
	}
	if (r.type === 'assistant' && r.block.type === 'text') return { ...r, block: { ...r.block, text } }
	if (r.type === 'user') {
		if (r.blocks.some((b) => b.type === 'text')) {
			let first = r.blocks.find((b) => b.type === 'text')!
			return { ...r, blocks: [{ ...first, text }, ...r.blocks.filter((b) => b.type !== 'text')] }
		}
		if (r.blocks.length === 1 && r.blocks[0]?.type === 'tool_result') {
			let { image: _image, ...b } = r.blocks[0]
			return { ...r, blocks: [{ ...b, output: text }] }
		}
	}
	throw new Error(`record #${r.n} is not editable`)
}

function apply(records: HistoryRecord[], plan: RebasePlan): HistoryRecord[] {
	let problem = rebase.invalid(plan)
	if (problem) throw new Error(problem)
	let byNumber = new Map(records.map((r) => [r.n, r]))
	for (let n of [...plan.drop, ...plan.edit.map((e) => e.n)]) {
		if (!byNumber.has(n)) throw new Error(`rebase record #${n} not found`)
		if (byNumber.get(n)!.type === 'rebase') throw new Error(`cannot rebase control record #${n}`)
	}
	let groups = rebase.groups(records), dropped = new Set(plan.drop.flatMap((n) => [...(groups.get(n) ?? [n])]))
	let edits = new Map(plan.edit.map((e) => [e.n, e.text]))
	for (let n of edits.keys()) if (dropped.has(n)) throw new Error(`record #${n} is edited but its group is dropped`)
	let results = new Map<number, Map<string, string>>()
	for (let [n, text] of edits) {
		let r = byNumber.get(n)!
		if (r.type !== 'assistant' || r.block.type !== 'tool_call') continue
		let id = r.block.id
		let target: number | undefined
		for (let next of records.slice(records.indexOf(r) + 1)) {
			if (next.type === 'user' && next.blocks.some((b) => b.type === 'tool_result' && b.id === id)) { target = next.n; break }
			if ((next.type === 'user' && next.blocks.some((b) => b.type === 'text')) || (next.type === 'assistant' && next.block.type === 'tool_call' && next.block.id === id)) break
		}
		if (target === undefined) throw new Error(`record #${n} is not editable: no tool result`)
		if (edits.has(target)) throw new Error(`conflicting edits of tool result #${target}`)
		let batch = results.get(target) ?? new Map<string, string>()
		batch.set(id, text); results.set(target, batch); edits.delete(n)
	}
	let projected = records.filter((r) => !dropped.has(r.n!)).map((r) => {
		if (edits.has(r.n!)) return rebase.edited(r, edits.get(r.n!)!)
		let batch = results.get(r.n!)
		if (r.type !== 'user' || !batch) return r
		return { ...r, blocks: r.blocks.map((b) => {
			if (b.type !== 'tool_result' || !batch.has(b.id)) return b
			let { image: _image, ...rest } = b
			return { ...rest, output: batch.get(b.id)! }
		}) }
	})
	let sources = new Map(projected.map((r) => [r.n, r]))
	return projected.map((r) => {
		if (r.type !== 'user' || !r.notices) return r
		let notices = r.notices.flatMap((notice) => {
			if (dropped.has(notice.source)) return []
			let source = sources.get(notice.source)
			if (source?.type !== 'notice' || !edits.has(notice.source)) return [notice]
			return [{ ...notice, text: modelNotices.text(source, {}) ?? '' }]
		})
		return notices.length === r.notices.length && notices.every((n, i) => n === r.notices![i]) ? r : { ...r, notices }
	})
}

// A newer plan against the same base replaces that plan; empty is undo.
// Other bases compose. Rebuild from original records, not edited clones.
function latest(records: HistoryRecord[]): HistoryRecord[] {
	let latest = new Map<number, HistoryRecord & { type: 'rebase' }>()
	for (let r of records) if (r.type === 'rebase') latest.set(r.base, r)
	return records.filter((r) => r.type !== 'rebase' || latest.get(r.base) === r)
}

export const rebase = { invalid, groups, text, edited, apply, latest }
