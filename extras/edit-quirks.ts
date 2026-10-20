// Some models write EDIT calls that the strict parser rejects; this module
// accepts them for those models only (task ybg). A strict EDIT failure
// from a listed model is retried after a text rewrite, one per quirk; any
// other model, or an unknown one, gets the strict error.
// Each firing goes to state/diag.log with its model: delete a quirk once
// the log shows no use, and this file once none is left.
// Enable with plugins/edit-quirks.ts: export { default } from '../extras/edit-quirks.ts'
import type { Plugin } from '../src/host/plugins.ts'
import { nativeTool } from '../src/host/native-tool.ts'
import { tools, type CallContext } from '../src/host/tools.ts'
import { diag } from '../src/host/diag.ts'

// Seen in benchmarks, 2026-10.
const sonnet = ['anthropic/claude-sonnet-5-5*']
export const quirks = {
	shell: sonnet, // "$ command" lines after the last block run as BASH
	markup: [...sonnet, 'anthropic/claude-opus-5-5*'], // <invoke> call markup after the last block runs its calls
	stray: sonnet, // a lone stray word, or a doubled !!END, after the last block is dropped
	emptyCall: sonnet, // a bare tool name, or a trailing EDIT with no operations, is dropped
	emptyReplace: sonnet, // a replace with empty !!OLD and !!NEW is dropped
	barePath: sonnet, // "path@" with no version means "path"
}
type Quirk = keyof typeof quirks

const N = '\n'
const header = / (replace|insert-before|insert-after|delete|create|write)(?: \d+(?:-\d+)?)?\s*$/
const known = (l: string) => {
	const m = /^([A-Z][A-Z_]*)(?=\s|\/\*|$)/.exec(l)?.[1]
	return !!m && tools.all().has(m.toLowerCase())
}
const applies = (q: Quirk, ctx?: CallContext) =>
	!!ctx?.model && quirks[q].some((p) => new Bun.Glob(p).match(ctx.model!))

// Indexes of lines outside !!OLD/!!NEW ... !!END blocks.
function outside(lines: string[]): number[] {
	const out: number[] = []
	let open = false
	for (const [i, l] of lines.entries()) {
		const m = /^!!(OLD|NEW|END)$/.exec(l)?.[1]
		if (open) {
			if (m === 'END') open = false
			continue
		}
		if (m === 'OLD' || m === 'NEW') {
			open = true
			continue
		}
		out.push(i)
	}
	return out
}

// The rewrite of an EDIT text a strict error points at, and its quirk.
export function fix(text: string, error: string): [string, Quirk] | undefined {
	const raw = text.split(N),
		lines = raw.map((l) => l.replace(/\r$/, '')),
		out = outside(lines)
	const headers = out.filter((i) => header.test(lines[i]!))
	const after = (i: number) => headers.some((h) => h < i)
	const got = /expected "<path>@<version> <operation> \[lines\]", got ("(?:[^"\\]|\\.)*")/.exec(error)
	if (got) {
		const want = JSON.parse(got[1]!) as string
		const k = out.find((i) => after(i) && lines[i]!.trim().slice(0, 120) === want)
		if (k === undefined) return
		const line = lines[k]!.trim()
		if (/^\$ \S/.test(line)) {
			for (let j = k; j < raw.length; j++)
				if (/^\s*\$ \S/.test(lines[j]!)) raw[j] = `BASH ${JSON.stringify(lines[j]!.trim().slice(2))}`
			return [raw.join(N), 'shell']
		}
		if (/^<\/?(invoke|parameter|function_calls|antml:)/.test(line)) {
			const rest = raw.slice(k).join(N),
				held: string[] = []
			for (const m of rest.matchAll(/<(?:antml:)?parameter name="cmd">([\s\S]*?)(?:<\/(?:antml:)?parameter>|$)/g))
				if (m[1]!.trim()) held.push(m[1]!.trim())
			return [[...raw.slice(0, k), ...held].join(N), 'markup']
		}
		if (/^\S+$/.test(line) && !/[@/.]/.test(line)) {
			const next = lines.slice(k + 1).find((l) => l.trim())
			if (next === undefined || known(next) || /^!!+[A-Z]+$/.test(next.trim()))
				return [raw.filter((_, j) => j !== k).join(N), 'stray']
		}
		return
	}
	if (/EDIT line \d+: replace needs nonempty old text/.test(error)) {
		const h = headers.find(
			(i) =>
				/ replace\s*$/.test(lines[i]!) &&
				lines[i + 1] === '!!OLD' &&
				lines[i + 2] === '!!NEW' &&
				lines[i + 3] === '!!END',
		)
		return h === undefined ? undefined : [raw.filter((_, j) => j < h || j > h + 3).join(N), 'emptyReplace']
	}
	if (error.startsWith('EDIT: the tool call after the last !!END is invalid')) {
		const last = headers.at(-1) ?? -1,
			alone = (i: number) => {
				const n = lines.slice(i + 1).find((l) => l.trim())
				return n === undefined || known(n)
			}
		const bare = out.find(
			(i) =>
				i > last &&
				/^[A-Z][A-Z_]*$/.test(lines[i]!.trim()) &&
				lines[i]!.trim() !== 'EDIT' &&
				known(lines[i]!.trim()) &&
				alone(i),
		)
		if (bare !== undefined) return [raw.filter((_, j) => j !== bare).join(N), 'emptyCall']
		// An EDIT after the last operation header takes the rest of the text.
		const edit = out.find((i) => i > last && /^EDIT\b/.test(lines[i]!))
		if (edit !== undefined) return [raw.slice(0, edit).join(N), 'emptyCall']
	}
}

export default function (plugin: Plugin) {
	plugin.around(nativeTool, 'resolve', (next, text, ctx) => {
		if (
			typeof text !== 'string' ||
			!/^\s*EDIT(?=\s|\/\*|$)/.test(text) ||
			!(Object.keys(quirks) as Quirk[]).some((q) => applies(q, ctx))
		)
			return next(text, ctx)
		const fired: Quirk[] = []
		let current = text,
			first: unknown
		for (;;) {
			let r: ReturnType<typeof next>
			try {
				r = next(current, ctx)
			} catch (e: any) {
				first ??= e
				const f = fired.length < 50 ? fix(current, String(e?.message ?? e)) : undefined
				if (!f || !applies(f[1], ctx)) throw first
				current = f[0]
				fired.push(f[1])
				continue
			}
			const edits = r.input.edits
			if (
				applies('barePath', ctx) &&
				Array.isArray(edits) &&
				edits.some((e) => typeof e?.path === 'string' && e.path.endsWith('@'))
			) {
				r = {
					...r,
					input: {
						...r.input,
						edits: edits.map((e) =>
							typeof e?.path === 'string' && e.path.endsWith('@') ? { ...e, path: e.path.slice(0, -1) } : e,
						),
					},
				}
				fired.push('barePath')
			}
			for (const q of fired)
				try {
					diag.log(`edit-quirks: ${q} fired for ${ctx!.model} in ${ctx!.sessionId}`)
				} catch {}
			return r
		}
	})
}
