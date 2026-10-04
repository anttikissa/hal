// Markdown in model text (task fn): one parser for both clients, so the
// terminal and the web never disagree. It returns blocks of styled runs,
// never HTML; renderers draw runs as SGR or as elements.
//
// `streaming`: the text may still grow. Then the parser is kind to
// prefixes, so a streaming block never shrinks: a trailing line that
// could start a table or heading, or that ends in a marker whose
// meaning the next character decides, is held back, and a construct
// still open at the end is taken as open (its marker hidden, its style
// running to the end). Done text shows an unclosed marker as written.

export interface Run {
	text: string
	bold?: boolean
	italic?: boolean
	code?: boolean
	href?: string
}
export type Style = Omit<Run, 'text'>
export type Line = { type: 'line'; kind: 'p' | 'h' | 'li' | 'quote'; marker: string; runs: Run[] }
// A code block keeps its fence lines as written; `close` is missing
// while the fence is still open.
export type Code = { type: 'code'; lang: string; open: string; lines: string[]; close?: string }
// Rows of cells of runs; the first row is the header.
export type Table = { type: 'table'; rows: Run[][][] }
export type Block = Line | Code | Table

const ENTITIES: Record<string, string> = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"' }
const WORD = /[\p{L}\p{N}]/u
const SEPARATOR = /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?$/

function same(a: Style, b: Style): boolean {
	return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.href === b.href
}

// The closer `until` at s[i]. A * that starts *** closes the italic
// inside ***bold italic***; _ never closes inside a word.
function closes(s: string, i: number, until: string): boolean {
	if (!s.startsWith(until, i) || (until !== ']' && /\s/.test(s[i - 1] ?? ' '))) return false
	if (until === '*') return s[i + 1] !== '*' || s[i + 2] === '*'
	if (until === '_') return !WORD.test(s[i + 1] ?? '')
	return true
}

// The emphasis marker opening at s[i]: after the start, a space or
// punctuation (never a letter or digit: 2**3, a*b, snake_case) and
// before a non-space.
function opener(s: string, i: number): string | undefined {
	if (WORD.test(s[i - 1] ?? '')) return undefined
	let m = s.startsWith('**', i) ? '**' : s[i] === '*' || s[i] === '_' ? s[i]! : undefined
	return m && /\S/.test(s[i + m.length] ?? ' ') ? m : undefined
}

type Scan = { runs: Run[]; end: number; closed: boolean }

// Runs from s[i] in style `st` until the closer `until`. Without a
// closer the scan fails, unless `open` (the text may still grow): then
// the style runs to the end.
function scan(s: string, i: number, st: Style, until: string, open: boolean): Scan | undefined {
	let runs: Run[] = []
	let add = (text: string, style: Style) => {
		let last = runs.at(-1)
		if (last && same(last, style)) last.text += text
		else if (text) runs.push({ ...style, text })
	}
	let join = (inner: Run[]) => inner.forEach((r) => add(r.text, r))
	while (i < s.length) {
		let c = s[i]!
		if (until && markdown.closes(s, i, until)) return { runs, end: i + until.length, closed: true }
		if (c === '\\' && /[\\`*_[\]()#|>&!/-]/.test(s[i + 1] ?? '')) {
			add(s[i + 1]!, st)
			i += 2
			continue
		}
		if (c === '`') {
			let n = /^`+/.exec(s.slice(i))![0].length
			let j = s.indexOf('`'.repeat(n), i + n)
			if (j < 0 && !open) add(s.slice(i, i + n), st)
			else add(s.slice(i + n, j < 0 ? undefined : j), { ...st, code: true })
			i = j < 0 ? (open ? s.length : i + n) : j + n
			continue
		}
		let m = markdown.opener(s, i)
		let inner = m && scan(s, i + m.length, { ...st, [m === '**' ? 'bold' : 'italic']: true }, m, open)
		if (inner) {
			join(inner.runs)
			i = inner.end
			continue
		}
		if (c === '[' && s[i - 1] !== '!' && /\S/.test(s[i + 1] ?? ' ')) {
			let label = scan(s, i + 1, { ...st, bold: true }, ']', open)
			let rest = label ? s.slice(label.end) : ''
			let url = /^\((https?:\/\/[^\s)]+|\/[\w-]+(?:#[a-z]?\d+(?:\.\d+)?)?)\)/.exec(rest)
			// While the text may grow, "](" and a partial http(s) address
			// may still come.
			let maybe = open && (!label?.closed || rest === '' || /^\((h(t(t(p(s?(:(\/(\/[^\s)]*)?)?)?)?)?)?)?)?$/.test(rest))
			if (label && (url || maybe)) {
				let href = url?.[1]
				join(label.runs.map((r) => ({ ...r, href })))
				i = url ? label.end + url[0].length : s.length
				continue
			}
		}
		// A bare URL ends at whitespace, <, the enclosing closer, or before
		// sentence punctuation and an unmatched ).
		let bare = c === 'h' && !WORD.test(s[i - 1] ?? '') ? /^https?:\/\/[^\s<]+/.exec(s.slice(i))?.[0] : undefined
		if (bare && until && bare.includes(until)) bare = bare.slice(0, bare.indexOf(until))
		while (bare && (/[.,;:!?]$/.test(bare) || (bare.endsWith(')') && bare.split('(').length < bare.split(')').length)))
			bare = bare.slice(0, -1)
		if (bare && /^https?:\/\/./.test(bare)) {
			add(bare, { ...st, href: bare })
			i += bare.length
			continue
		}
		let entity = c === '&' ? /^&(nbsp|amp|lt|gt|quot);/.exec(s.slice(i)) : null
		add(entity ? ENTITIES[entity[1]!]! : c, st)
		i += entity ? entity[0].length : 1
	}
	return until && !open ? undefined : { runs, end: i, closed: !until }
}

function inline(s: string, open = false): Run[] {
	return scan(s, 0, {}, '', open)!.runs
}

function line(s: string, open: boolean): Line {
	if (/^\s*&nbsp;\s*$/.test(s)) return { type: 'line', kind: 'p', marker: '', runs: [] }
	let h = /^#{1,6}(?:\s+|$)(.*)$/.exec(s)
	if (h) return { type: 'line', kind: 'h', marker: '', runs: inline(h[1]!, open).map((r) => ({ ...r, bold: true })) }
	let q = /^>\s?(.*)$/.exec(s)
	if (q) return { type: 'line', kind: 'quote', marker: '> ', runs: inline(q[1]!, open) }
	let li = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)(.*)$/.exec(s)
	if (li) return { type: 'line', kind: 'li', marker: li[1]!, runs: inline(li[2]!, open) }
	return { type: 'line', kind: 'p', marker: '', runs: inline(s, open) }
}

function cells(row: string, open: boolean): Run[][] {
	return row
		.trim()
		.replace(/^\||\|$/g, '')
		.split('|')
		.map((c) => c.trim().split(/<br\s*\/?>/i).flatMap((line, i) => [...(i ? [{ text: '\n' }] : []), ...inline(line, open)]))
}

function parse(text: string, streaming = false): Block[] {
	let lines = text.split('\n')
	let out: Block[] = []
	for (let i = 0; i < lines.length; i++) {
		let s = lines[i]!
		let tail = streaming && i === lines.length - 1
		let fence = /^\s*(`{3,})(.*)$/.exec(s)
		if (fence) {
			let end = new RegExp(`^\\s*${fence[1]}\`*\\s*$`)
			let j = i + 1
			while (j < lines.length && !end.test(lines[j]!)) j++
			out.push({ type: 'code', lang: fence[2]!.trim(), open: s, lines: lines.slice(i + 1, j), close: lines[j] })
			i = j
			continue
		}
		if (s.trimStart().startsWith('|')) {
			let j = i
			while (j < lines.length && lines[j]!.trimStart().startsWith('|')) j++
			// The last line may be half a row, and a lone first row may
			// yet get its separator: until the next line tells, they are
			// blank rows.
			let rows = lines.slice(i, streaming && j === lines.length ? j - 1 : j)
			let undecided = streaming && rows.length < 2 && (j === lines.length || (j === lines.length - 1 && lines[j] === ''))
			if (undecided) rows = []
			if (rows.length > 1 && SEPARATOR.test(rows[1]!)) out.push({ type: 'table', rows: [rows[0]!, ...rows.slice(2)].map((r) => cells(r, false)) })
			else rows.forEach((r) => out.push(markdown.line(r, false)))
			for (let k = i + rows.length; k < j; k++) out.push(markdown.line('', false))
			i = j - 1
			continue
		}
		if (tail) {
			// Whether # heads a line, or what a trailing marker means,
			// is known only from the next character.
			if (/^#{1,6}$/.test(s)) s = ''
			s = s.replace(/(&[a-z]{0,5}|[*_[\\]+)$/, '')
		}
		out.push(markdown.line(s, tail))
	}
	return out
}

export const markdown = { parse, line, inline, closes, opener }
