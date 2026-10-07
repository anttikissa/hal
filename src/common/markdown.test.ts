import { describe, expect, test } from 'bun:test'
import { markdown, type Run } from './markdown.ts'

// Visible text with *…* around italic, **…** around bold, `…` around
// code and <…> after a link label, to compare shapes briefly.
function show(runs: Run[]): string {
	return runs
		.map((r) => {
			let t = r.code ? `\`${r.text}\`` : r.text
			if (r.italic) t = `*${t}*`
			if (r.bold) t = `**${t}**`
			return r.href ? `${t}<${r.href}>` : t
		})
		.join('')
}
const done = (s: string) => show(markdown.inline(s))
const open = (s: string) => show(markdown.inline(s, true))

describe('inline', () => {
	test('styles and links', () => {
		expect(done('a **b** *c* _d_ `e*f*` [g](https://x.y/z)')).toBe('a **b** *c* *d* `e*f*` **g**<https://x.y/z>')
		expect(markdown.inline('***both***')).toEqual([{ text: 'both', bold: true, italic: true }])
	})

	test('markers inside words or before a space stay text', () => {
		for (let s of ['2**3 and 4**5', 'a*b*c', 'snake_case_name', 'a * b * c', 'x = y *'] as const) expect(done(s)).toBe(s)
	})

	test('an unclosed marker opens while the text may grow, shows when done', () => {
		expect(open('at **17:40')).toBe('at **17:40**')
		expect(done('at **17:40')).toBe('at **17:40')
		expect(open('run `ls -')).toBe('run `ls -`')
		expect(done('run `ls -')).toBe('run `ls -')
		expect(open('see [the doc')).toBe('see **the doc**')
		expect(open('see [the doc](htt')).toBe('see **the doc**')
		expect(done('[A1] and [x] done')).toBe('[A1] and [x] done')
	})

	test('only http and https addresses become links', () => {
		expect(done('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))')
		expect(markdown.inline('[x](javascript:alert(1))', true).some((r) => r.href)).toBe(false)
	})

	test('bare http(s) URLs are links, without sentence punctuation', () => {
		expect(done('see https://x.dev/a.')).toBe('see https://x.dev/a<https://x.dev/a>.')
		expect(done('(https://x.dev/b), ok')).toBe('(https://x.dev/b<https://x.dev/b>), ok')
		expect(done('https://w.org/F_(x)?')).toBe('https://w.org/F_(x)<https://w.org/F_(x)>?')
		expect(done('**at http://a.b/c**<d')).toBe('**at ****http://a.b/c**<http://a.b/c><d')
		expect(done('`https://x.dev` ftp://x javascript:alert(1) xhttps://x')).toBe('`https://x.dev` ftp://x javascript:alert(1) xhttps://x')
	})

	test('entities decode outside code, backslash escapes', () => {
		expect(done('a &amp; &lt;b&gt; `&amp;` \\*x\\*')).toBe('a & <b> `&amp;` *x*')
	})
})

describe('parse', () => {
	test('blocks', () => {
		let blocks = markdown.parse('# Title\n- item\n> quote\n```ts\n  keep **this**\n```\n| a | b |\n|---|:-:|\n| 1 | 2 |\n&nbsp;\nend')
		expect(blocks.map((b) => (b.type === 'line' ? b.kind : b.type))).toEqual(['h', 'li', 'quote', 'code', 'table', 'p', 'p'])
		expect(blocks[3]).toEqual({ type: 'code', lang: 'ts', open: '```ts', lines: ['  keep **this**'], close: '```' })
		let table = blocks[4]!
		expect(table.type === 'table' && table.rows.map((r) => r.map(show))).toEqual([['a', 'b'], ['1', '2']])
		expect(blocks[5]).toEqual({ type: 'line', kind: 'p', marker: '', runs: [] })
	})
	test('table cell line breaks become newlines, without interpreting arbitrary HTML', () => {
		let block = markdown.parse('| window | value |\n|---|---|\n| 5h | ▉<br>95% used |')[0]!
		expect(block.type === 'table' && block.rows[1]![1]!.map((r) => r.text).join('')).toBe('▉\n95% used')
		expect(markdown.inline('<script>alert(1)</script>').map((r) => r.text).join('')).toBe('<script>alert(1)</script>')
	})

	test('an open fence is code to the end', () => {
		expect(markdown.parse('```\nx\n**y')).toEqual([{ type: 'code', lang: '', open: '```', lines: ['x', '**y'], close: undefined }])
	})

	test('while streaming, undecided lines are blank rows until the next line', () => {
		let kinds = (s: string, streaming = true) => markdown.parse(s, streaming).map((b) => (b.type !== 'line' ? b.type : b.runs.length ? b.kind : '-'))
		expect(kinds('a\n| h |')).toEqual(['p', '-'])
		expect(kinds('a\n| h |\n')).toEqual(['p', '-', '-'])
		expect(kinds('a\n| h |\n|--')).toEqual(['p', '-', '-'])
		expect(kinds('a\n| h |\n|---|\n| 1')).toEqual(['p', 'table', '-'])
		expect(kinds('a\n| h |\nb')).toEqual(['p', 'p', 'p'])
		expect(kinds('a\n##')).toEqual(['p', '-'])
		expect(kinds('a\n## T')).toEqual(['p', 'h'])
		expect(kinds('a\n| h |', false)).toEqual(['p', 'p'])
	})
})

test('block ids link to cards the writer could have seen; code, invented ids and punctuation stay text (task d92)', () => {
	let links = markdown.blockLinks('06-abc', '20', (s) => s === '05-xyz')
	let hrefs = (s: string) => markdown.parse(s, false, links).flatMap((b) => (b.type === 'line' ? b.runs : [])).filter((r) => r.href).map((r) => [r.text, r.href])
	expect(hrefs('see #t5.')).toEqual([['#t5', '/06-abc#t5']])
	expect(hrefs('see `#t5` and #t99 and #1 and #fff')).toEqual([])
	expect(hrefs('in 05-xyz#u3, not 07-qqq#u3')).toEqual([['05-xyz#u3', '/05-xyz#u3']])
	expect(hrefs('#u6.1 then a#t5')).toEqual([['#u6.1', '/06-abc#u6.1']])
	expect(hrefs('05-xyz, 64-bit and 05-xyzw')).toEqual([['05-xyz', '/05-xyz']])
	markdown.state.sessions = new Set(['05-xyz'])
	expect(markdown.parse('05-xyz#t2 07-qqq#t2', false, markdown.blockLinks('06-abc', '20')).flatMap((b) => (b.type === 'line' ? b.runs : [])).filter((r) => r.href).map((r) => r.href)).toEqual(['/05-xyz#t2'])
	markdown.state.sessions = new Set()
	expect(markdown.parse('#t5', false).flatMap((b) => (b.type === 'line' ? b.runs : [])).some((r) => r.href)).toBe(false)
})
