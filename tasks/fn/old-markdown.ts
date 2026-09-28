// The inline half of Hal's deliberately small markdown parser. It is shared by
// terminal and web renderers: callers choose their own style delimiters instead
// of making browser code understand terminal escape sequences.

export interface MarkdownStyles {
	bold: [on: string, off: string]
	italic: [on: string, off: string]
	code: [on: string, off: string]
	link?: [on: string, off: string]
}

export type MdSpan =
	| { type: 'text', lines: string[] }
	| { type: 'code', lang: string, lines: string[] }
	| { type: 'table', lines: string[] }

/** Split source into text, fenced code, and table spans before either renderer lays it out. */
export function mdSpans(text: string): MdSpan[] {
	const spans: MdSpan[] = []
	let lines: string[] = []
	let inCode = false
	let lang = ''
	function flushText(): void {
		if (!lines.length) return
		spans.push({ type: 'text', lines })
		lines = []
	}
	for (const line of text.split('\n')) {
		if (line.startsWith('```')) {
			if (inCode) {
				spans.push({ type: 'code', lang, lines })
				lines = []
				inCode = false
				lang = ''
			} else {
				flushText()
				lang = line.slice(3).trim()
				inCode = true
			}
			continue
		}
		if (inCode) {
			lines.push(line)
			continue
		}
		if (/^\|.+\|$/.test(line.trim())) {
			flushText()
			const previous = spans.at(-1)
			if (previous?.type === 'table') previous.lines.push(line)
			else spans.push({ type: 'table', lines: [line] })
			continue
		}
		lines.push(line)
	}
	if (lines.length) spans.push(inCode ? { type: 'code', lang, lines } : { type: 'text', lines })
	return spans
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u0000/g, '&#0;')
}

function emphasis(text: string, styles: MarkdownStyles): string {
	text = text.replace(/\*\*(.+?)\*\*/g, `${styles.bold[0]}$1${styles.bold[1]}`)
	return text.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, `${styles.italic[0]}$1${styles.italic[1]}`)
}

function inlineSpans(text: string, styles: MarkdownStyles, renderLink?: (url: string, label: string) => string): string {
	// Extract code and links before emphasis so their markdown-looking contents
	// cannot affect surrounding text.
	const codes: string[] = []
	const codePlaceholder = (index: number) => `\x00C${index}\x00`

	// **`bold code`** → bold only (no second code style)
	text = text.replace(/\*\*`([^`]+)`\*\*/g, (_, code) => {
		const index = codes.length
		codes.push(`${styles.bold[0]}${code}${styles.bold[1]}`)
		return codePlaceholder(index)
	})
	text = text.replace(/`([^`\n]+)`/g, (_, code) => {
		const index = codes.length
		codes.push(`${styles.code[0]}${code}${styles.code[1]}`)
		return codePlaceholder(index)
	})

	const links: Array<{ label: string, url: string }> = []
	const linkPlaceholder = (index: number) => `\x00L${index}\x00`
	text = text.replace(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s)\x00-\x1f]+)\)/g, (_, label, url) => {
		const index = links.length
		links.push({ label, url })
		return linkPlaceholder(index)
	})

	text = emphasis(text, styles)
	const linkStyle = styles.link ?? styles.bold
	text = text.replace(/\x00L(\d+)\x00/g, (_, rawIndex) => {
		const link = links[+rawIndex]!
		const label = `${linkStyle[0]}${emphasis(link.label, styles)}${linkStyle[1]}`
		return renderLink ? renderLink(link.url, label) : label
	})
	return text.replace(/\x00C(\d+)\x00/g, (_, index) => codes[+index]!)
}

/** Render one source line. Browser callers use the safe default; terminal callers preserve text. */
function inline(source: string, styles: MarkdownStyles, renderLink?: (url: string, label: string) => string, escape = escapeHtml): string {
	let line = escape(source)
	const escaped: string[] = []
	const placeholder = (index: number) => `\x00E${index}\x00`

	// Code spans come first because Markdown treats backslashes in them literally.
	line = line.replace(/`[^`\n]+`|\\([\\`*#\[\]()])/g, (match, marker) => {
		if (!marker) return match
		const index = escaped.length
		escaped.push(marker)
		return placeholder(index)
	})
	const header = line.match(/^(#{1,6})\s+(.*)/)
	const rendered = header
		? `${styles.bold[0]}${inlineSpans(header[2]!, styles, renderLink)}${styles.bold[1]}`
		: inlineSpans(line, styles, renderLink)
	return rendered.replace(/\x00E(\d+)\x00/g, (_, index) => escaped[+index]!)
}

export const markdown = { escapeHtml, inline, mdSpans }
