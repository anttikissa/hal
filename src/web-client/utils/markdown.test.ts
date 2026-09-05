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

test('status tables become wrapping account blocks with labeled usage meters', () => {
	const source = '| Slot | Account | 5h | Sonnet 7d |\n|---|---|---|---|\n| 1/2 * | a@test.com<br>Expired | \uE100hal-usage:56:14\uE101<br>50% used (resets 09:38) | ? |'
	const result = webMarkdown.html(source, true)
	expect(result).toContain('class="UsageAccounts"')
	expect(result).toContain('Slot 1/2 · Current')
	expect(result).toContain('a@test.com<br>Expired')
	expect(result).toContain('<dt>5h</dt>')
	expect(result).toContain('<meter min="0" max="100" value="50" aria-label="Usage used">50%</meter>')
	expect(result).toContain('50% used (resets 09:38)')
	expect(result).toContain('<dt>Sonnet 7d</dt><dd>Unavailable</dd>')
	expect(result).not.toContain('hal-usage:')
	expect(webMarkdown.html(source)).toContain('<table>')
})

test('status formatting does not enable arbitrary HTML and clamps malformed bars', () => {
	const result = webMarkdown.html('| Slot | Account | 7d |\n|---|---|---|\n| 1/1 | <img src=x onerror=alert(1)> | \uE100hal-usage:999:1\uE101<br>Full |', true)
	expect(result).toContain('&lt;img src=x onerror=alert(1)&gt;')
	expect(result).not.toContain('<img')
	expect(result).toContain('value="100"')
	expect(webMarkdown.html('Literal <br> and <script>')).toBe('Literal &lt;br&gt; and &lt;script&gt;')
})
