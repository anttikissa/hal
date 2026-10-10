// Sparse rebase syntax and snapshot targeting; no history mutation.
// Tasks: svt.
import { rebase, type RebasePlan } from './rebase.ts'
import type { RebaseRow, RebaseRows } from './rebase-rows.ts'

export type RebaseTarget = { kinds: string; from: number; to?: number }
export type SparseRebase = { plan: RebasePlan; tails: RebaseTarget[] }

function letter(row: RebaseRow): string {
	if (row.tool) return 't'
	if (row.kind === 'prompt') return 'u'
	if (row.kind === 'assistant') return 'a'
	if (row.kind === 'thinking') return 'r'
	if (['queued', 'advisory', 'interjecting', 'steering'].includes(row.kind)) return 'm'
	if (['command', 'output', 'compact', 'reset', 'note', 'instructions', 'settings'].includes(row.kind)) return 's'
	return 't'
}

function targets(text: string): RebaseTarget[] {
	let parts = text.trim().replace(/\s*-\s*/g, '-').split(/[\s,]+/).filter(Boolean)
	if (!parts.length) throw new Error('drop needs at least one target')
	return parts.map((part) => {
		let m = /^#?([traumsq]*)(?:(\d+)(?:(-)(?:#?([traumsq]*)(\d+))?)?|(\*))$/i.exec(part)
		if (!m) throw new Error(`Invalid rebase target: ${part}`)
		let kinds = m[1]!.toLowerCase(), endKinds = (m[4] ?? '').toLowerCase()
		if (endKinds && endKinds !== kinds) throw new Error(`Range kind prefixes must agree: ${part}`)
		let from = m[6] ? 0 : Number(m[2]), to = m[6] || (m[3] && !m[5]) ? undefined : Number(m[5] ?? m[2])
		if (!Number.isSafeInteger(from) || (to !== undefined && !Number.isSafeInteger(to))) throw new Error(`Invalid rebase number: ${part}`)
		if (to !== undefined && from > to) [from, to] = [to, from]
		return { kinds, from, ...(to !== undefined && { to }) }
	})
}

function matches(row: RebaseRow, target: RebaseTarget): boolean {
	return row.n >= target.from && row.n <= (target.to ?? Infinity) && (!target.kinds || target.kinds.includes(rebaseSparse.letter(row)))
}

// Only an edit's quoted operand treats semicolons as literal text. The
// scanner rejects all unknown escapes rather than silently changing text.
function parse(text: string, snapshot: RebaseRows): SparseRebase {
	let at = 0, out: SparseRebase = { plan: { base: snapshot.base, drop: [], edit: [] }, tails: [] }
	let space = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++ }
	let fail = (message: string): never => { throw new Error(`Rebase at character ${at + 1}: ${message}\n${text}`) }
	space()
	if (at === text.length) fail('expected drop or edit')
	while (at < text.length) {
		let verb = /^(drop|edit)\s+/.exec(text.slice(at))
		if (!verb) fail('expected drop or edit followed by targets')
		at += verb![0].length
		if (verb![1] === 'drop') {
			let end = text.indexOf(';', at)
			if (end < 0) end = text.length
			for (let target of rebaseSparse.targets(text.slice(at, end))) {
				let rows = snapshot.rows.filter((row) => rebaseSparse.matches(row, target))
				if (!rows.length && target.to !== undefined) fail(`no entries match ${text.slice(at, end)}`)
				out.plan.drop.push(...rows.flatMap((row) => row.ns))
				if (target.to === undefined) out.tails.push(target)
			}
			at = end
		} else {
			let target = /^(#?[a-z]*\d+)\s+/.exec(text.slice(at))
			if (!target) fail('edit needs one entry and a quoted full replacement')
			let selector = rebaseSparse.targets(target![1]!)[0]!
			let row = snapshot.rows.find((row) => rebaseSparse.matches(row, selector))
			if (!row?.editable || row.editN === undefined) fail(`entry ${target![1]} is absent or not editable`)
			at += target![0].length
			let quote = text[at++]
			if (quote !== '"' && quote !== "'" && quote !== '`') fail('replacement must use double, single or backtick quotes')
			let value = '', closed = false
			while (at < text.length) {
				let c = text[at++]!
				if (c === quote) { closed = true; break }
				if (c === '\\') {
					let escaped = text[at++]
					if (escaped === 'n') c = '\n'
					else if (escaped === 't') c = '\t'
					else if (escaped === '\\' || escaped === quote) c = escaped!
					else fail(`unsupported escape \\${escaped ?? ''}`)
				}
				value += c
			}
			if (!closed) fail('unterminated replacement')
			out.plan.edit.push({ n: row!.editN!, text: value })
		}
		space()
		if (at === text.length) break
		if (text[at++] !== ';') fail('expected semicolon between operations')
		space()
		if (at === text.length) fail('expected an operation after semicolon')
	}
	out.plan.drop = [...new Set(out.plan.drop)]
	let problem = rebase.invalid(out.plan)
	if (problem) fail(problem)
	rebase.apply(snapshot.records, out.plan)
	return out
}

function resolve(sparse: SparseRebase, current: RebaseRows): RebasePlan {
	let drop = [...new Set([...sparse.plan.drop, ...current.rows.filter((row) => sparse.tails.some((target) => rebaseSparse.matches(row, target))).flatMap((row) => row.ns)])]
	return { ...sparse.plan, drop }
}

export const rebaseSparse = { letter, targets, matches, parse, resolve }
