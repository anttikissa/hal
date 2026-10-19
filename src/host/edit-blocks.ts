// The EDIT block format (task ybg): its help text and the strict parser
// from !!OLD/!!NEW/!!END text to edit operations.
import { tools } from './tools.ts'

const N = String.fromCharCode(10)
const help = [
	'Apply one atomic batch of operations across files. Each operation is a header line, followed by its block:',
	'  <path>@<version> replace A-B       then !!NEW, new lines, !!END',
	'  <path>@<version> insert-before N   then !!NEW ... !!END',
	'  <path>@<version> insert-after N    then !!NEW ... !!END',
	'  <path>@<version> delete A-B        (no block)',
	'  <path>@<version> delete            (no block; deletes the file)',
	'  <path> replace                     then !!OLD, exact old text, !!NEW, new text, !!END (old must match exactly once)',
	'  <path> create                      then !!NEW ... !!END (file must not exist)',
	'  <path>@<version> write             then !!NEW, whole new contents, !!END',
	'Block content is literal: no quoting or escaping. Only a content line that is itself a marker needs one extra ! ' +
		'(write !!!END for a literal !!END line). Always submit the <version> READ gave (<path>@<version>); line numbers ' +
		"are 1-based, inclusive and all refer to that version. Text replaces apply after a file's line operations. " +
		'Nothing is written unless every operation validates. Results show file contents or diffs with new versions; no ' +
		'confirmation READ is needed.',
].join(N)

// The edits a block-format EDIT text stands for. Throws with the line at fault.
function parseBlocks(raw: string): { edits: Record<string, unknown>[]; then?: string[]; purpose?: string } {
	const lines = raw.split(N).map((l) => l.replace(/\r$/, ''))
	let purpose: string | undefined,
		i = 0
	const first = lines[0]!.trim()
	if (first.startsWith('/*')) {
		const close = raw.indexOf('*/')
		if (close < 0) throw new Error('EDIT: unclosed /* purpose comment; close it with */')
		purpose =
			raw
				.slice(raw.indexOf('/*') + 2, close)
				.trim()
				.replace(/\s+/g, ' ') || undefined
		const rest = raw.slice(close + 2)
		return { ...parseBlocks(rest.startsWith(N) || rest.startsWith(' ') ? rest : N + rest), ...(purpose && { purpose }) }
	}
	const marker = (l: string) => /^!!(OLD|NEW|END)$/.exec(l)?.[1]
	const content = (l: string) => (/^!!!+(OLD|NEW|END)$/.test(l) ? l.slice(1) : l)
	const block = (until: string[], at: number): [string[], string, number] => {
		const out: string[] = []
		for (let j = at; j < lines.length; j++) {
			const m = marker(lines[j]!)
			if (m && until.includes(m)) return [out, m, j + 1]
			if (m)
				throw new Error(
					`EDIT line ${j + 1}: unexpected !!${m} inside a block; a literal marker line takes one extra ! (!!!${m})`,
				)
			out.push(content(lines[j]!))
		}
		throw new Error(`EDIT line ${at}: block never closed; end it with !!${until.join(' or !!')}`)
	}
	const edits: Record<string, unknown>[] = [],
		then: string[] = []
	const known = (l: string) => {
		const m = /^([A-Z][A-Z_]*)(?=\s|\/\*|$)/.exec(l)?.[1]
		return m && tools.all().has(m.toLowerCase()) ? m : undefined
	}
	while (i < lines.length) {
		const line = lines[i]!.trim(),
			at = i + 1
		if (!line) {
			i++
			continue
		}
		// Calls after the last block run, in order, once the edit succeeds.
		if (edits.length && known(lines[i]!)) {
			let chunk: string[] = []
			for (const l of lines.slice(i)) {
				if (known(l) && chunk.length && known(chunk[0]!) !== 'EDIT') {
					then.push(chunk.join(N).trimEnd())
					chunk = []
				}
				chunk.push(l)
			}
			then.push(chunk.join(N).trimEnd())
			break
		}
		const header = line
			.replace(/:(\d+(?:-\d+)?)\s+(replace|delete|insert-before|insert-after)\s*$/i, ' $2 $1')
			.replace(/\b(replace|delete|insert-before|insert-after):(\d+(?:-\d+)?)\s*$/i, '$1 $2')
		const h =
			/^(.+?)(?:@([A-Za-z0-9]+))? (replace|insert-before|insert-after|delete|create|write)(?: (\d+)(?:-(\d+))?)?\s*$/i.exec(
				header,
			)
		if (!h)
			throw new Error(
				`EDIT line ${at}: expected "<path>@<version> <operation> [lines]", got ${JSON.stringify(line.slice(0, 120))}. Operations: replace A-B, insert-before N, insert-after N, delete A-B, delete (file), replace (text), create, write`,
			)
		const [, path, hash, operation, a, b] = h,
			op = operation!.toLowerCase()
		const need = (ok: boolean, what: string) => {
			if (!ok) throw new Error(`EDIT line ${at}: ${op} ${what}`)
		}
		const open = (name: string) => {
			need(marker(lines[i + 1] ?? '') === name, `must be followed by !!${name} on the next line`)
			i += 2
		}
		const range = a === undefined ? undefined : b === undefined ? a : `${a}-${b}`
		// The version is advisory: checked when given, never required.
		const v = hash ? { hash } : {}
		if (op === 'replace' && range === undefined) {
			open('OLD')
			const [old, end, j] = block(['NEW', 'END'], i)
			i = j
			// Undocumented tolerance: !!OLD closed by !!END removes the text.
			let next: string[] = []
			if (end === 'NEW') [next, , i] = block(['END'], i)
			need(old.join(N).length > 0, 'needs nonempty old text')
			edits.push({ path, old: old.join(N), new: next.join(N), ...v })
		} else if (op === 'delete' && range === undefined) {
			edits.push({ path, ...v, delete: true })
			i++
		} else if (op === 'replace' || op === 'delete') {
			need(range !== undefined, 'needs a line range A-B')
			let body: string[] = []
			if (op === 'replace') {
				open('NEW')
				const [c, , j] = block(['END'], i)
				body = c
				i = j
			} else i++
			edits.push({ path, ...v, range, lines: body })
		} else if (op === 'insert-before' || op === 'insert-after') {
			need(a !== undefined && b === undefined, 'needs one line number')
			open('NEW')
			const [c, , j] = block(['END'], i)
			i = j
			edits.push({ path, ...v, insert: Number(a) + (op === 'insert-after' ? 1 : 0), lines: c })
		} else {
			need(range === undefined, 'takes no line numbers')
			open('NEW')
			const [c, , j] = block(['END'], i)
			i = j
			edits.push({
				path,
				new: c.length ? c.join(N) + N : '',
				...(op === 'write' && v),
				...(op === 'create' && { create: true }),
			})
		}
		if (op === 'delete' && marker(lines[i] ?? '') === 'END') i++
	}
	if (!edits.length) throw new Error(`EDIT needs at least one operation.${N}${help}`)
	return { edits, ...(then.length && { then }), ...(purpose && { purpose }) }
}

export const editBlocks = { help, parse: parseBlocks }
