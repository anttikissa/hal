import { expect, test } from 'bun:test'
import { webMarkdown } from './markdown.ts'

test('web markdown makes links tappable while escaping source text', () => {
	const result = webMarkdown.html('Read [docs](https://example.com/a?one=1&two=2) and `<unsafe>`.')
	expect(result).toContain('<a href="https://example.com/a?one=1&amp;two=2" target="_blank" rel="noreferrer">')
	expect(result).toContain('<code>&lt;unsafe&gt;</code>')
})

test('web markdown gives code fences and tables native elements', () => {
	const result = webMarkdown.html('```ts\nconst answer = 42\n```\n\n| name | value |\n|---|---|\n| answer | **42** |')
	expect(result).toContain('<pre><code>const answer = 42</code></pre>')
	expect(result).toContain('<table><thead><tr><th>name</th><th>value</th></tr></thead><tbody><tr><td>answer</td><td><b>42</b></td></tr></tbody></table>')
})
