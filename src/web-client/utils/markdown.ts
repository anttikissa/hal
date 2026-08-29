import { markdown } from '../../common/markdown.ts'

const styles = {
	bold: ['<b>', '</b>'] as [string, string],
	italic: ['<i>', '</i>'] as [string, string],
	code: ['<code>', '</code>'] as [string, string],
	link: ['<span class="Markdown-link">', '</span>'] as [string, string],
}

function inline(source: string): string {
	return markdown.inline(source, styles, (url, label) => `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`)
}

function table(lines: string[]): string {
	const rows = lines
		.filter((line) => !/^\|[\s\-:|]+\|$/.test(line.trim()))
		.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
	if (!rows.length) return ''
	const [head, ...body] = rows
	const row = (cells: string[], cell: 'td' | 'th') => `<tr>${cells.map((value) => `<${cell}>${inline(value)}</${cell}>`).join('')}</tr>`
	return `<table><thead>${row(head!, 'th')}</thead><tbody>${body.map((cells) => row(cells, 'td')).join('')}</tbody></table>`
}

function html(source: string): string {
	const blocks: string[] = []
	for (const span of markdown.mdSpans(source)) {
		if (span.type === 'text') blocks.push(span.lines.map(inline).join('\n'))
		else if (span.type === 'code') blocks.push(`<pre><code>${markdown.escapeHtml(span.lines.join('\n'))}</code></pre>`)
		else blocks.push(table(span.lines))
	}
	return blocks.join('\n')
}

export const webMarkdown = { html }
