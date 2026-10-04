// Cost reads this home's durable usage, never the running host (task asa).
import { readdirSync } from 'fs'
import type { Usage } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { pricing } from '../common/pricing.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'

type Sample = { model: string; usage: Usage; ts: string }
type Total = { session: string; model: string; rounds: number; usage: Usage; cost: number; unpriced: number }

function samples(records: HistoryRecord[], fallback: string): Sample[] {
	let out: Sample[] = [], pending: Sample[] = []
	let model = fallback
	let end: Sample | undefined
	// A paused/failed end carries cumulative usage on continue. Count its
	// rounds once, or the last aggregate if this legacy turn has no rounds.
	let flush = () => {
		out.push(...(pending.length ? pending : end ? [end] : []))
		pending = []
		end = undefined
	}
	for (let r of records) {
		if (r.type === 'change' && r.model) model = r.model
		if (r.type === 'assistant' && r.model) model = r.model
		if (r.type === 'user' && end && r.blocks.some((b) => b.type === 'text')) flush()
		if (r.type === 'round') pending.push({ model: r.model ?? model, usage: r.usage, ts: r.ts })
		if (r.type === 'turn_end') {
			end = { model, usage: r.usage, ts: r.ts }
			if (r.status === 'completed') flush()
		}
	}
	flush()
	return out
}

function totals(ids: string[], since?: number): Total[] {
	let out: Total[] = []
	for (let id of ids) {
		let meta = sessions.load(id, false)
		let fallback = meta.model
		liveFiles.close(meta)
		let groups = new Map<string, Total>()
		for (let sample of cost.samples(history.readSync(id), fallback)) {
			let timestamp = Date.parse(sample.ts)
			if (!Number.isFinite(timestamp)) throw new Error(`${history.file(id)}: invalid usage timestamp ${JSON.stringify(sample.ts)}`)
			if (since !== undefined && timestamp < since) continue
			let total = groups.get(sample.model) ?? { session: id, model: sample.model, rounds: 0, usage: {}, cost: 0, unpriced: 0 }
			groups.set(sample.model, total)
			total.rounds++
			let prices = models.pricing(sample.model)
			// Validate usage even for a model without prices.
			let value = pricing.cost(sample.usage, prices ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
			for (let key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) total.usage[key] = (total.usage[key] ?? 0) + (sample.usage[key] ?? 0)
			if (!prices || value === undefined) total.unpriced++
			else total.cost += value
		}
		out.push(...groups.values())
	}
	return out
}

function run(args: string[]): string {
	let ids: string[] = []
	let since: number | undefined
	for (let i = 0; i < args.length; i++) {
		let arg = args[i]!
		if (arg === '--since') {
			let raw = args[++i]
			since = raw === undefined ? NaN : Date.parse(raw)
			if (!Number.isFinite(since)) throw new Error('--since needs a valid date/time (include a timezone)')
		} else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}; usage: scripts/cost [--since <time>] [session ids...]`)
		else ids.push(arg)
	}
	if (!ids.length) ids = readdirSync(paths.sessionsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
	let totals = cost.totals([...new Set(ids)], since)
	let money = (n: number) => `$${n.toFixed(4)}`
	let lines = ['SESSION  PROVIDER/MODEL  LIST COST (USD)  ROUNDS  INPUT  OUTPUT  CACHE READ  CACHE WRITE']
	let sum = 0, unknown = 0
	for (let t of totals) {
		sum += t.cost
		unknown += t.unpriced
		lines.push(`${t.session}  ${t.model}  ${money(t.cost)}${t.unpriced ? ` + UNPRICED (${t.unpriced} rounds)` : ''}  ${t.rounds}  ${t.usage.input ?? 0}  ${t.usage.output ?? 0}  ${t.usage.cacheRead ?? 0}  ${t.usage.cacheWrite ?? 0}`)
	}
	for (let provider of new Set(totals.map((t) => t.model.split('/')[0]!))) {
		let rows = totals.filter((t) => t.model.startsWith(`${provider}/`))
		lines.push(`PROVIDER ${provider}  ${money(rows.reduce((n, t) => n + t.cost, 0))}${rows.some((t) => t.unpriced) ? ' + UNPRICED' : ''}`)
	}
	for (let model of new Set(totals.map((t) => t.model))) {
		let rows = totals.filter((t) => t.model === model)
		lines.push(`MODEL ${model}  ${money(rows.reduce((n, t) => n + t.cost, 0))}${rows.some((t) => t.unpriced) ? ' + UNPRICED' : ''}`)
	}
	lines.push(`TOTAL  ${money(sum)}${unknown ? ` + UNPRICED (${unknown} rounds; total incomplete)` : ''}`)
	return lines.join('\n')
}

export const cost = { samples, totals, run }
