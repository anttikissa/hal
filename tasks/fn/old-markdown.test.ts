import { expect, test } from 'bun:test'
import { markdown } from './markdown.ts'

const htmlStyles = {
	bold: ['<b>', '</b>'] as [string, string],
	italic: ['<i>', '</i>'] as [string, string],
	code: ['<code>', '</code>'] as [string, string],
	link: ['<span class="link">', '</span>'] as [string, string],
}

test('renders inline markdown with caller-provided markup', () => {
	expect(markdown.inline('Use **bold**, *italic*, and `code`.', htmlStyles)).toBe('Use <b>bold</b>, <i>italic</i>, and <code>code</code>.')
})

test('renders only safe web links through the caller link wrapper', () => {
	const link = (url: string, label: string) => `<a href="${url}">${label}</a>`
	expect(markdown.inline('Read [the **docs**](https://example.com/a?one=1&two=2).', htmlStyles, link)).toBe('Read <a href="https://example.com/a?one=1&amp;two=2"><span class="link">the <b>docs</b></span></a>.')
	expect(markdown.inline('[nope](javascript:alert(1))', htmlStyles, link)).toBe('[nope](javascript:alert(1))')
})

test('escapes model text before inserting web markup', () => {
	expect(markdown.inline('<script>alert(1)</script> & **safe**', htmlStyles)).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; <b>safe</b>')
})
