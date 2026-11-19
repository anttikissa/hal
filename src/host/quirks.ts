// Calls Hal can read although they break the advertised syntax (task hq6).
// Prompts teach one syntax; this module holds all leniency for call text,
// so the strict parser stays simple. native-tool resolves strictly first;
// a strict failure comes here, and each step applies the first quirk whose
// rewrite changes the text, then resolves again. If no rewrite resolves,
// the strict error stands. Quirks apply to every model and to humans.
// Each firing goes to state/diag.log: delete quirks the log shows unused.
import { ason } from '../common/ason.ts'
import { callText } from '../common/call-text.ts'
import { diag } from './diag.ts'
import type { CallContext } from './tools.ts'
import { tools } from './tools.ts'

type Resolved = { name: string; input: Record<string, unknown> }
type Quirk = {
	// The case it accepts and who was seen writing it.
	about: string
	fix?(text: string, error: any): string | undefined
	// Corrects a call that resolved strictly but means something else.
	adjust?(call: Resolved): Resolved | undefined
}

const N = '\n'
const editHeader = / (replace|insert-before|insert-after|delete|create|write)(?: \d+(?:-\d+)?)?\s*$/
const isEdit = (text: string) => /^\s*EDIT(?=\s|\/\*|$)/i.test(text)
const known = (word: string) => tools.all().some((t) => t.name === word.toLowerCase())
const knownLine = (l: string) => {
	let m = /^([A-Z][A-Z_]*)(?=\s|\/\*|$)/.exec(l)?.[1]
	return !!m && known(m)
}

// Indexes of EDIT lines outside !!OLD/!!NEW ... !!END blocks.
function outside(lines: string[]): number[] {
	let out: number[] = []
	let open = false
	for (let [i, l] of lines.entries()) {
		let m = /^!!(OLD|NEW|END)$/.exec(l)?.[1]
		if (open) {
			if (m === 'END') open = false
			continue
		}
		if (m === 'OLD' || m === 'NEW') open = true
		else out.push(i)
	}
	return out
}

// The EDIT line a strict "expected <path>@<version>…" error names, if it
// follows an operation header.
function editLine(text: string, error: string): { raw: string[]; lines: string[]; k: number } | undefined {
	let got = /expected "<path>@<version> <operation> \[lines\]", got ("(?:[^"\\]|\\.)*")/.exec(error)
	if (!got) return
	let raw = text.split(N),
		lines = raw.map((l) => l.replace(/\r$/, '')),
		out = outside(lines)
	let headers = out.filter((i) => editHeader.test(lines[i]!))
	let want = JSON.parse(got[1]!) as string
	let k = out.find((i) => headers.some((h) => h < i) && lines[i]!.trim().slice(0, 120) === want)
	return k === undefined ? undefined : { raw, lines, k }
}

// The text after a call's leading /* comments and the given number of
// argument values on its first line, as [prefix, rest].
function afterValues(raw: string, count: number): [string, string] | undefined {
	let i = 0
	for (let n = 0; ;) {
		while (raw[i] === ' ' || raw[i] === '\t') i++
		if (raw.startsWith('/*', i)) {
			let close = raw.indexOf('*/', i + 2)
			if (close < 0) return
			i = close + 2
			continue
		}
		if (n++ === count) break
		if ('{["\'`'.includes(raw[i] ?? '')) {
			try {
				i = ason.parseAt(raw, i).end
			} catch {
				return
			}
		} else while (i < raw.length && !/\s/.test(raw[i]!)) i++
	}
	return [raw.slice(0, i), raw.slice(i)]
}

// `text` as [body, options]: a trailing { ... } naming only fields of
// `tool` is options. Null when it parses but names other fields, which
// could be a typo as well as text.
function trailingOptions(text: string, tool: string): [string, string] | null {
	let def = tools.all().find((t) => t.name === tool)
	let fields = Object.keys((def?.parameters as any)?.properties ?? {})
	for (let i = text.lastIndexOf(' {'); i >= 0; i = text.lastIndexOf(' {', i - 1)) {
		let parsed: { value: unknown; end: number }
		try {
			parsed = ason.parseAt(text, i + 1)
		} catch {
			continue
		}
		if (text.slice(parsed.end).trim()) break
		let value = parsed.value
		if (!value || typeof value !== 'object' || Array.isArray(value)) break
		if (!Object.keys(value).every((k) => fields.includes(k))) return null
		return [text.slice(0, i).trimEnd(), text.slice(i + 1).trim()]
	}
	return [text, '']
}

export const list: Quirk[] = [
	{
		about: "READ_BLOB, READ_ENTRY's old name, which old notices in histories still show",
		fix: (text) => (/^\s*READ_BLOB(?=\s|\/\*|$)/i.test(text) ? text.replace(/READ_BLOB/i, 'READ_ENTRY') : undefined),
	},
	{
		about: 'a lone !!NEW line opening a block outside EDIT means !!START (models used to EDIT)',
		fix: (text, e) => (e?.code === 'block-new' ? text.replace(/^!!NEW(?=\r?$)/m, '!!START') : undefined),
	},
	{
		about:
			"rest of line: bare words after the name (and after earlier plain arguments) are the main text field verbatim, as humans type: bash ls -l; send 12-abc hello there. A trailing { ... } is options only if it names only that tool's fields",
		fix(text) {
			if (callText.hasMarker(text)) return
			let m = /^\s*([A-Za-z_]+)(?=[ \t]|\/\*)/.exec(text)
			if (!m) return
			let name = m[1]!.toLowerCase()
			let tool = tools.all().find((t) => t.name === name)
			let field = tool?.syntax?.block
			if (!tool || !field || name === 'edit') return
			let raw = text.slice(m[0].length)
			let line = raw.split(N)[0]!.replace(/\r$/, '')
			if (raw.slice(line.length).trim()) return
			let positional = tool.syntax?.positional ?? ((tool.parameters as any)?.required as string[]) ?? []
			let before = Math.max(0, positional.indexOf(field))
			let split = afterValues(line, before)
			if (!split) return
			let rest = split[1].trim()
			if (!rest || '{["\'`'.includes(rest[0]!)) return
			let parts = trailingOptions(rest, name)
			if (!parts || !parts[0]) return
			let [body, options] = parts
			let content = /^!!+(START|END)$/.test(body) ? `!${body}` : body
			return `${m[1]}${split[0]}${options ? ` ${options}` : ''}${N}!!START${N}${content}${N}!!END`
		},
	},
	{
		about: 'EDIT "then !!NEW" or "then !!OLD", copied from the usage text (seen: claude-opus-5-5, 2026-11)',
		fix(text) {
			if (!isEdit(text)) return
			let out: string[] = []
			let open = false
			for (let line of text.split(N)) {
				let bare = line.replace(/\r$/, '')
				if (open) {
					if (bare === '!!END') open = false
					out.push(line)
					continue
				}
				let m = /^(?:(.*\S)\s+)?then\s+(!!(?:NEW|OLD))$/.exec(bare)
				if (m) {
					if (m[1]) out.push(m[1])
					out.push(m[2]!)
					open = true
				} else {
					if (/^!!(OLD|NEW)$/.test(bare)) open = true
					out.push(line)
				}
			}
			return out.join(N)
		},
	},
	{
		about: 'EDIT: "$ command" lines after the last block run as BASH (seen: claude-sonnet-5-5, 2026-10)',
		fix(text, e) {
			let at = isEdit(text) ? editLine(text, String(e?.message ?? e)) : undefined
			if (!at || !/^\$ \S/.test(at.lines[at.k]!.trim())) return
			for (let j = at.k; j < at.raw.length; j++)
				if (/^\s*\$ \S/.test(at.lines[j]!)) at.raw[j] = `BASH ${JSON.stringify(at.lines[j]!.trim().slice(2))}`
			return at.raw.join(N)
		},
	},
	{
		about: 'EDIT: <invoke> call markup after the last block runs its calls (seen: claude-sonnet-5-5, claude-opus-5-5)',
		fix(text, e) {
			let at = isEdit(text) ? editLine(text, String(e?.message ?? e)) : undefined
			if (!at || !/^<\/?(invoke|parameter|function_calls|antml:)/.test(at.lines[at.k]!.trim())) return
			let held: string[] = []
			for (let m of at.raw
				.slice(at.k)
				.join(N)
				.matchAll(/<(?:antml:)?parameter name="cmd">([\s\S]*?)(?:<\/(?:antml:)?parameter>|$)/g))
				if (m[1]!.trim()) held.push(m[1]!.trim())
			return [...at.raw.slice(0, at.k), ...held].join(N)
		},
	},
	{
		about: 'EDIT: a lone stray word, or a doubled !!END, after the last block is dropped (seen: claude-sonnet-5-5)',
		fix(text, e) {
			let at = isEdit(text) ? editLine(text, String(e?.message ?? e)) : undefined
			if (!at) return
			let line = at.lines[at.k]!.trim()
			if (!/^\S+$/.test(line) || /[@/.]/.test(line)) return
			let next = at.lines.slice(at.k + 1).find((l) => l.trim())
			if (next === undefined || knownLine(next) || /^!!+[A-Z]+$/.test(next.trim()))
				return at.raw.filter((_, j) => j !== at.k).join(N)
		},
	},
	{
		about: 'EDIT: a replace with empty !!OLD and !!NEW is dropped (seen: claude-sonnet-5-5)',
		fix(text, e) {
			if (!isEdit(text) || !/EDIT line \d+: replace needs nonempty old text/.test(String(e?.message ?? e))) return
			let raw = text.split(N),
				lines = raw.map((l) => l.replace(/\r$/, ''))
			let h = outside(lines).find(
				(i) =>
					/ replace\s*$/.test(lines[i]!) &&
					lines[i + 1] === '!!OLD' &&
					lines[i + 2] === '!!NEW' &&
					lines[i + 3] === '!!END',
			)
			return h === undefined ? undefined : raw.filter((_, j) => j < h || j > h + 3).join(N)
		},
	},
	{
		about:
			'EDIT: a bare tool name, or a trailing EDIT with no operations, after the last block is dropped (seen: claude-sonnet-5-5)',
		fix(text, e) {
			if (!isEdit(text) || !String(e?.message ?? e).startsWith('EDIT: the tool call after the last !!END is invalid'))
				return
			let raw = text.split(N),
				lines = raw.map((l) => l.replace(/\r$/, '')),
				out = outside(lines)
			let last = out.filter((i) => editHeader.test(lines[i]!)).at(-1) ?? -1
			let alone = (i: number) => {
				let n = lines.slice(i + 1).find((l) => l.trim())
				return n === undefined || knownLine(n)
			}
			let bare = out.find(
				(i) =>
					i > last &&
					/^[A-Z][A-Z_]*$/.test(lines[i]!.trim()) &&
					lines[i]!.trim() !== 'EDIT' &&
					known(lines[i]!.trim()) &&
					alone(i),
			)
			if (bare !== undefined) return raw.filter((_, j) => j !== bare).join(N)
			let edit = out.find((i) => i > last && /^EDIT\b/.test(lines[i]!))
			if (edit !== undefined) return raw.slice(0, edit).join(N)
		},
	},
	{
		about:
			'EDIT: further !!OLD/!!NEW pairs under one text replace header, with or without !!END between them, are more replaces of that file (seen: 2026-11)',
		fix(text, e) {
			let m = /^EDIT line (\d+): (unexpected !!OLD inside a block|expected "<path>@<version>[^]*got "!!OLD")/.exec(
				String(e?.message ?? e),
			)
			if (!isEdit(text) || !m) return
			let raw = text.split(N),
				lines = raw.map((l) => l.replace(/\r$/, '')),
				k = Number(m[1]) - 1
			if (lines[k] !== '!!OLD') return
			let header = lines.slice(0, k).findLast((l) => /^\S+/.test(l) && editHeader.test(l))
			let before = lines.slice(0, k).findLast((l) => /^!!(OLD|NEW|END)$/.test(l))
			let open = m[2]!.startsWith('unexpected')
			if (!header || !/^\S+ replace\s*$/.test(header) || before !== (open ? '!!NEW' : '!!END')) return
			raw.splice(k, 0, ...(open ? ['!!END', header] : [header]))
			return raw.join(N)
		},
	},
	{
		about: 'EDIT: "insert after N" or "insert before N" means insert-after or insert-before (seen: 2026-11)',
		fix(text, e) {
			let got = /expected "<path>@<version> <operation> \[lines\]", got ("(?:[^"\\]|\\.)*")/.exec(
				String(e?.message ?? e),
			)
			if (!isEdit(text) || !got) return
			let want = JSON.parse(got[1]!) as string
			let raw = text.split(N)
			let k = outside(raw.map((l) => l.replace(/\r$/, ''))).find((i) => raw[i]!.trim().slice(0, 120) === want)
			if (k === undefined || !/ insert (after|before) \d+\s*$/.test(raw[k]!)) return
			raw[k] = raw[k]!.replace(/ insert (after|before)( \d+\s*)$/, ' insert-$1$2')
			return raw.join(N)
		},
	},
	{
		about: 'EDIT: "path@" with no version means "path" (seen: claude-sonnet-5-5)',
		adjust(call) {
			let edits = call.input.edits
			if (
				call.name !== 'edit' ||
				!Array.isArray(edits) ||
				!edits.some((e) => typeof e?.path === 'string' && e.path.endsWith('@'))
			)
				return
			let fixed = edits.map((e) =>
				typeof e?.path === 'string' && e.path.endsWith('@') ? { ...e, path: e.path.slice(0, -1) } : e,
			)
			return { ...call, input: { ...call.input, edits: fixed } }
		},
	},
]

function fired(quirk: Quirk, ctx?: CallContext): void {
	try {
		diag.log(`quirk fired for ${ctx?.model ?? 'unknown model'} in ${ctx?.sessionId ?? 'no session'}: ${quirk.about}`)
	} catch {}
}

function adjusted(call: Resolved, ctx?: CallContext): Resolved {
	for (let q of quirks.list) {
		let next = q.adjust?.(call)
		if (next) {
			fired(q, ctx)
			call = next
		}
	}
	return call
}

// The call `text` stands for, given its strict resolver. Throws the
// strict error when no quirk makes it resolve.
function resolve(text: unknown, ctx: CallContext | undefined, strict: (text: string) => Resolved): Resolved {
	let first: unknown
	try {
		return adjusted(strict(text as string), ctx)
	} catch (e) {
		first = e
		if (typeof text !== 'string') throw e
	}
	let current = text as string,
		error = first,
		used: Quirk[] = []
	for (let step = 0; step < 20; step++) {
		let next: string | undefined
		let q = quirks.list.find((q) => {
			next = q.fix?.(current, error)
			return next !== undefined && next !== current
		})
		if (!q) break
		current = next!
		used.push(q)
		try {
			let call = strict(current)
			for (let u of used) fired(u, ctx)
			return adjusted(call, ctx)
		} catch (e) {
			error = e
		}
	}
	throw first
}

// Calls joined on one line with "; ", like READ "a"; BASH "b" (seen:
// claude-opus-5-5, gpt-6.1-sol, 2026-11), as separate lines. Splits only
// after a closed quoted, array or object argument followed by a tool
// name, so shell text and literal blocks never split. Undefined when
// there is nothing to split.
function joined(text: string, ctx?: CallContext): string | undefined {
	if (callText.hasMarker(text)) return
	let changed = false
	let lines = text.split(N).map((line) => {
		let out = ''
		let i = 0,
			from = 0
		while (i < line.length) {
			let c = line[i]!
			if ('{["\'`'.includes(c)) {
				try {
					i = ason.parseAt(line, i).end
				} catch {
					return out + line.slice(from)
				}
				let m = /^\s*;\s+([A-Za-z_]+)(?=[\s"'`{[]|\/\*|$)/.exec(line.slice(i))
				if (m && known(m[1]!)) {
					out += line.slice(from, i) + N
					from = i = i + m[0].length - m[1]!.length
					changed = true
				}
			} else i++
		}
		return out + line.slice(from)
	})
	if (!changed) return
	fired({ about: 'calls joined with "; " on one line' }, ctx)
	return lines.join(N)
}

export const quirks = { list, resolve, joined }
