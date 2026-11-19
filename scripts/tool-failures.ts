#!/usr/bin/env bun
// Finds which tool calls fail and why, so recurring failures can be fixed
// in guidance or tools. Reads session histories of the last N days,
// writes every failed call (input and error) to an ASON file and prints
// counts per tool, the most common errors and failures per model.
//
// bun scripts/tool-failures.ts <out.ason> [days=14] [sessions dir]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { ason } from '../src/common/ason.ts'

const [out, days = '14', dir = `${import.meta.dir}/../sessions`] = process.argv.slice(2)
if (!out) throw new Error('usage: bun scripts/tool-failures.ts <out.ason> [days=14] [sessions dir]')
const since = new Date(Date.now() - Number(days) * 864e5).toISOString()
const cap = 8000

type Call = { session: string; ts: string; model?: string; name: string; cmd?: string; input: unknown }
let calls = new Map<string, Call>()
let results = new Map<string, { isError: boolean; output: string }>()
let hosted: (Call & { isError: boolean; output: string })[] = []

const clip = (s: string) => (s.length > cap ? `${s.slice(0, cap)}… [${s.length - cap} more chars]` : s)

for (let session of readdirSync(dir)) {
	let files: string[]
	try {
		files = readdirSync(`${dir}/${session}`).filter(
			(f) => /^history\d*\.asonl$/.test(f) && statSync(`${dir}/${session}/${f}`).mtime.toISOString() >= since,
		)
	} catch {
		continue
	}
	for (let file of files)
		for (let line of readFileSync(`${dir}/${session}/${file}`, 'utf8').split('\n')) {
			if (!line.includes("'tool_") && !line.includes("'hosted_tool'")) continue
			let r: any
			try {
				r = ason.parse(line)
			} catch {
				continue
			}
			if (!r?.ts || r.ts < since) continue
			let b = r.block
			if (r.type === 'assistant' && b?.type === 'tool_call') {
				// Forked sessions copy their parent's calls.
				if (!calls.has(b.id))
					calls.set(b.id, {
						session,
						ts: r.ts,
						model: r.model,
						name: String(b.name).toLowerCase(),
						cmd: b.cmd,
						input: b.input,
					})
			} else if (r.type === 'assistant' && b?.type === 'hosted_tool') {
				hosted.push({
					session,
					ts: r.ts,
					model: r.model,
					name: `hosted:${b.name}`,
					input: b.input,
					isError: !!b.isError,
					output: b.output ?? '',
				})
			} else if (r.type === 'user') {
				for (let x of r.blocks ?? [])
					if (x.type === 'tool_result' && !results.has(x.id))
						results.set(x.id, { isError: !!x.isError, output: x.isError ? (x.output ?? '') : '' })
			}
		}
}

let byTool: Record<string, { ok: number; failed: number; noResult: number }> = {}
let failed: any[] = []
const count = (name: string, kind: 'ok' | 'failed' | 'noResult') =>
	(byTool[name] ??= { ok: 0, failed: 0, noResult: 0 })[kind]++
for (let [id, c] of calls) {
	let r = results.get(id)
	if (!r) count(c.name, 'noResult')
	else if (!r.isError) count(c.name, 'ok')
	else {
		count(c.name, 'failed')
		failed.push({ ...c, input: c.cmd ? undefined : c.input, error: clip(r.output) })
	}
}
for (let h of hosted) {
	count(h.name, h.isError ? 'failed' : 'ok')
	if (h.isError) failed.push({ ...h, isError: undefined, output: undefined, error: clip(h.output) })
}
failed.sort((a, b) => (a.ts < b.ts ? -1 : 1))
let tools = Object.entries(byTool).sort((a, b) => b[1].ok + b[1].failed - (a[1].ok + a[1].failed))
let total = { ok: 0, failed: 0, noResult: 0 }
for (let [, t] of tools) for (let k of ['ok', 'failed', 'noResult'] as const) total[k] += t[k]

writeFileSync(
	out,
	ason.stringify(
		{
			about: `Hal tool calls from ${since} (${days} days) in ${dir}. failed = result flagged isError (a BASH command exiting non-zero is ok). noResult = interrupted before a result. Failed entries keep the raw cmd; input only when no cmd was recorded. Errors over ${cap} chars are clipped.`,
			total,
			byTool: Object.fromEntries(tools),
			failed,
		},
		'long',
	) + '\n',
)

console.log('total', JSON.stringify(total))
for (let [name, t] of tools) console.log(name.padEnd(14), t.ok, t.failed, t.noResult)
let groups = new Map<string, number>()
for (let f of failed) {
	let first = String(f.error)
		.replace(/^\[[^\]]*\]\n/, '')
		.split('\n')[0]!
	let key = `${f.name} | ${first.replace(/[0-9a-f]{5,}|\d+/g, '#').slice(0, 90)}`
	groups.set(key, (groups.get(key) ?? 0) + 1)
}
console.log('\nmost common errors:')
for (let [k, n] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(n).padStart(4), k)
let models = new Map<string, number>()
for (let f of failed) models.set(f.model, (models.get(f.model) ?? 0) + 1)
console.log('\nfailures by model:', JSON.stringify(Object.fromEntries(models)))
