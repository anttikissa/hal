import { attachments } from '../common/attachments.ts'

// Link targets in shown text: attachment markers, plain URLs, blobs.

// A prompt's text in parts, each [image/<name>] or [paste/<name>]
// marker a link to its page (tasks qy, 31).
function links(text: string): (string | { href: string; text: string })[] {
	let out: (string | { href: string; text: string })[] = [], from = 0
	for (let m of text.matchAll(attachments.fileMarker)) {
		if (m.index > from) out.push(text.slice(from, m.index))
		out.push({ href: `/${m[1]!}`, text: m[0] })
		from = m.index + m[0].length
	}
	if (from < text.length) out.push(text.slice(from))
	return out
}

// Plain question text: link URLs without interpreting Markdown or HTML.
function urlParts(text: string): (string | { href: string; text: string })[] {
	let out: (string | { href: string; text: string })[] = [], from = 0
	for (let m of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/g)) {
		let href = m[0]
		while (/[.,;:!?]$/.test(href) || (href.endsWith(')') && href.split('(').length < href.split(')').length)) href = href.slice(0, -1)
		if (!/^https?:\/\/./.test(href)) continue
		if (m.index > from) out.push(text.slice(from, m.index))
		out.push({ href, text: href })
		from = m.index + href.length
	}
	if (from < text.length) out.push(text.slice(from))
	return out
}

// Where the page loads a session's image from (host/web.ts).
function blobUrl(sessionId: string, blob: string): string {
	return `/blob/${encodeURIComponent(sessionId)}/${encodeURIComponent(blob)}`
}

export const hrefs = { links, urlParts, blobUrl }
