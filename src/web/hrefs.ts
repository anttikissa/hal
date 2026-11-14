// Link targets in shown text: attachment markers, plain URLs, blobs.
import { attachments } from '../common/attachments.ts'
import { titles } from '../common/titles.ts'
import type { Shown } from '../common/transcript.ts'

// A prompt's text in parts, each [image/<name>] or [paste/<name>]
// marker a link to its page (tasks qy, 31), and each plain URL a link.
function links(text: string): (string | { href: string; text: string })[] {
	let out: (string | { href: string; text: string })[] = [],
		from = 0
	for (let m of text.matchAll(attachments.fileMarker)) {
		if (m.index > from) out.push(...urlParts(text.slice(from, m.index)))
		out.push({ href: `/${m[1]!}`, text: m[0] })
		from = m.index + m[0].length
	}
	if (from < text.length) out.push(...urlParts(text.slice(from)))
	return out
}

// Plain question text: link URLs without interpreting Markdown or HTML.
function urlParts(text: string): (string | { href: string; text: string })[] {
	let out: (string | { href: string; text: string })[] = [],
		from = 0
	for (let m of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/g)) {
		let href = m[0]
		while (/[.,;:!?]$/.test(href) || (href.endsWith(')') && href.split('(').length < href.split(')').length))
			href = href.slice(0, -1)
		if (!/^https?:\/\/./.test(href)) continue
		if (m.index > from) out.push(text.slice(from, m.index))
		out.push({ href, text: href })
		from = m.index + href.length
	}
	if (from < text.length) out.push(text.slice(from))
	return out
}

function headerParts(item: Shown, text: string): ReturnType<typeof urlParts> {
	return titles.senderParts(item, text).flatMap((p) => (typeof p === 'string' ? hrefs.urlParts(p) : [p]))
}

// A closed reply or prompt: its sender in the title color, its text
// in the body color it has open, as a closed Bash card shows output.
function compactParts(item: Shown, head: string) {
	let who = titles.who(item) ?? ''
	return who && head.startsWith(`${who}: `)
		? { who: `${who}:`, text: hrefs.urlParts(head.slice(who.length + 2)) }
		: undefined
}

// Where the page loads a session's image from (host/web.ts).
function blobUrl(sessionId: string, blob: string): string {
	return `/blob/${encodeURIComponent(sessionId)}/${encodeURIComponent(blob)}`
}

export const hrefs = { links, urlParts, headerParts, compactParts, blobUrl }
