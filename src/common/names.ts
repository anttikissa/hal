// Naming controls are suffixes, never examples embedded in prose or code.
function validate(text: string): string {
	if (/[\p{Cc}\p{Cf}<>]/u.test(text)) throw new Error('session name contains controls or markup')
	let name = text.replace(/\s+/gu, ' ').trim()
	if (!name) throw new Error('session name must not be empty')
	if (Array.from(name).length > 60) throw new Error('session name must be at most 60 characters')
	return name
}
function fallback(id: string): string { return `Session ${id}` }
function suffix(text: string): { start: number; title: string } | undefined {
	let match = /(?:^|\n)[ \t]*<rename>([^<>]*)<\/rename>\s*(?:<summary>[^<>]*<\/summary>\s*)?$/u.exec(text)
	if (!match || text.slice(0, match.index).includes('<rename>') || (text.slice(0, match.index).match(/```/g)?.length ?? 0) % 2) return
	return { start: match.index, title: match[1]! }
}
// Only a possible trailing control is withheld, not the answer before it.
function strip(text: string): string {
	let found = names.suffix(text)
	if (found) return text.slice(0, found.start).trimEnd()
	let open = /(?:^|\n)[ \t]*<rename>/gu
	let start = [...text.matchAll(open)].at(-1)?.index
	if (start !== undefined && (text.slice(0, start).match(/```/g)?.length ?? 0) % 2 === 0 && !text.slice(0, start).includes('<rename>') && !text.slice(start).includes('</rename>')) return text.slice(0, start).trimEnd()
	let at = text.lastIndexOf('\n') + 1
	let tail = text.slice(at).trimStart()
	if ('<rename>'.startsWith(tail) && tail && (text.slice(0, at).match(/```/g)?.length ?? 0) % 2 === 0 && !text.slice(0, at).includes('<rename>')) return text.slice(0, at).trimEnd()
	return text
}
export const names = { validate, fallback, suffix, strip }
