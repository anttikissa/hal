import { markdown } from '../../common/markdown.ts'
import { subscriptionUsage } from '../../common/subscription-usage.ts'

const styles = {
	bold: ['<b>', '</b>'] as [string, string],
	italic: ['<i>', '</i>'] as [string, string],
	code: ['<code>', '</code>'] as [string, string],
	link: ['<span class="Markdown-link">', '</span>'] as [string, string],
}

function inline(source: string): string {
	return markdown.inline(source, styles, (url, label) => `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`)
}

// Only /status opts in: recognize its line breaks without allowing source HTML.
function usageCell(source: string): string {
	if (source === '?') return 'Unavailable'
	const rendered = source.split('<br>').map(inline).join('<br>')
	return subscriptionUsage.replaceUsageBarMarkers(rendered, (eighths, width) => {
		if (!Number.isFinite(eighths) || !Number.isFinite(width) || width <= 0) return ''
		const percent = Math.round(Math.max(0, Math.min(100, eighths / (width * 8) * 100)))
		return `<meter min="0" max="100" value="${percent}" aria-label="Usage used">${percent}%</meter>`
	})
}

function usageAccounts(head: string[], rows: string[][]): string {
	const accounts: string[] = []
	for (const cells of rows) {
		const slot = (cells[0] ?? '').replace(/ \*$/, ' · Current')
		const windows: string[] = []
		for (let index = 2; index < head.length; index++) {
			const value = cells[index] ?? ''
			if (!value) continue // The server suppresses windows overridden by an exhausted longer quota.
			windows.push(`<div><dt>${inline(head[index]!)}</dt><dd>${webMarkdown.usageCell(value)}</dd></div>`)
		}
		accounts.push(`<article><header><small>Slot ${inline(slot)}</small><strong>${webMarkdown.usageCell(cells[1] ?? '')}</strong></header><dl>${windows.join('')}</dl></article>`)
	}
	return `<div class="UsageAccounts">${accounts.join('')}</div>`
}

function table(lines: string[], usageBars: boolean): string {
	const rows = lines
		.filter((line) => !/^\|[\s\-:|]+\|$/.test(line.trim()))
		.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
	if (!rows.length) return ''
	const [head, ...body] = rows
	if (usageBars && head?.[0] === 'Slot' && head[1] === 'Account') return webMarkdown.usageAccounts(head, body)
	const row = (cells: string[], cell: 'td' | 'th') => `<tr>${cells.map((value) => `<${cell}>${inline(value)}</${cell}>`).join('')}</tr>`
	return `<table><thead>${row(head!, 'th')}</thead><tbody>${body.map((cells) => row(cells, 'td')).join('')}</tbody></table>`
}

function html(source: string, usageBars = false): string {
	const blocks: string[] = []
	for (const span of markdown.mdSpans(source)) {
		if (span.type === 'text') blocks.push(span.lines.map(inline).join('\n'))
		else if (span.type === 'code') blocks.push(`<pre><code>${markdown.escapeHtml(span.lines.join('\n'))}</code></pre>`)
		else blocks.push(table(span.lines, usageBars))
	}
	return blocks.join('\n')
}

export const webMarkdown = { html, usageCell, usageAccounts }
