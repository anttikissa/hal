import { readEscapeSequence } from './tui-text.ts'

export const OSC8_CLOSE = '\x1b]8;;\x1b\\'

// Schemes from Ghostty's url.zig
const URL_RE =
	/(?:https?:\/\/|ftp:\/\/|ssh:\/\/|git:\/\/|file:\/\/?|mailto:|tel:\+?|magnet:\?|ipfs:\/\/|ipns:\/\/|gemini:\/\/|gopher:\/\/|news:)\S+/g

/** Extract OSC 8 URI from an escape sequence, or null if not OSC 8 */
export function parseOsc8Uri(seq: string): string | null {
	if (!seq.startsWith('\x1b]8;')) return null
	// Format: \x1b]8;params;uri\x07 or \x1b]8;params;uri\x1b\\
	// First ; is at index 3 (after "8"), second ; separates params from URI
	const secondSemi = seq.indexOf(';', 4)
	if (secondSemi < 0) return null
	let end = seq.length
	if (seq.endsWith('\x07')) end = seq.length - 1
	else if (seq.endsWith('\x1b\\')) end = seq.length - 2
	return seq.slice(secondSemi + 1, end)
}

function countChar(s: string, ch: string, end: number): number {
	let n = 0
	for (let i = 0; i < end; i++) if (s[i] === ch) n++
	return n
}

const PROSE_TRIM = '.,:;!?\'">'
const MD_TRIM = '*`_~'

function trimTrailing(url: string, includeMarkdown: boolean): string {
	const chars = includeMarkdown ? PROSE_TRIM + MD_TRIM : PROSE_TRIM
	let end = url.length
	while (end > 0) {
		const ch = url[end - 1]
		if (chars.includes(ch)) { end--; continue }
		if (ch === ')' && countChar(url, ')', end) > countChar(url, '(', end)) { end--; continue }
		if (ch === ']' && countChar(url, ']', end) > countChar(url, '[', end)) { end--; continue }
		break
	}
	return url.slice(0, end)
}
export function normalizeDetectedUrl(url: string): string {
	let value = url.trim()
	let changed = true
	while (changed && value.length > 1) {
		changed = false
		// Try matching wrapper pairs first (before trimming eats the closing char)
		const first = value[0]
		const last = value[value.length - 1]
		if (
			(first === '`' && last === '`') ||
			(first === '*' && last === '*') ||
			(first === '_' && last === '_') ||
			(first === '~' && last === '~') ||
			(first === '"' && last === '"') ||
			(first === "'" && last === "'") ||
			(first === '<' && last === '>') ||
			(first === '(' && last === ')') ||
			(first === '[' && last === ']') ||
			(first === '{' && last === '}')
		) {
			value = value.slice(1, -1).trim()
			changed = true
			continue
		}
		// Strip trailing prose punctuation (preserves markdown chars for pair matching)
		const trimmed = trimTrailing(value, false)
		if (trimmed.length < value.length) {
			value = trimmed
			changed = true
		}
	}
	// Final pass: strip any remaining trailing markdown chars (no leading match)
	return trimTrailing(value, true)
}

/** Strip ANSI from line, returning plain text and position map (posMap[plainIdx] = origIdx) */
function stripAnsiMap(line: string): { plain: string; posMap: number[] } {
	const chars: string[] = []
	const posMap: number[] = []
	let i = 0
	while (i < line.length) {
		if (line[i] === '\x1b') { i += readEscapeSequence(line, i); continue }
		posMap.push(i)
		chars.push(line[i])
		i++
	}
	return { plain: chars.join(''), posMap }
}

function findUrlsInPlain(plain: string): { start: number; end: number; url: string }[] {
	URL_RE.lastIndex = 0
	const urls: { start: number; end: number; url: string }[] = []
	let match
	while ((match = URL_RE.exec(plain)) !== null) {
		const trimmed = trimTrailing(match[0], true)
		urls.push({ start: match.index, end: match.index + trimmed.length, url: trimmed })
	}
	return urls
}

/**
 * Wrap URLs in an ANSI-colored line with OSC 8 hyperlink sequences.
 * Skips lines that already contain OSC 8.
 */
export function linkifyLine(line: string): string {
	if (!line || line.includes('\x1b]8;')) return line
	const { plain, posMap } = stripAnsiMap(line)
	const urls = findUrlsInPlain(plain)
	if (urls.length === 0) return line

	let result = ''
	let lastOrigEnd = 0
	for (const u of urls) {
		const origStart = posMap[u.start]
		const origEnd = u.end < posMap.length ? posMap[u.end] : line.length
		result += line.slice(lastOrigEnd, origStart)
		result += `\x1b]8;;${u.url}\x1b\\` + line.slice(origStart, origEnd) + OSC8_CLOSE
		lastOrigEnd = origEnd
	}
	return result + line.slice(lastOrigEnd)
}

/** Find the URL at a given visible column in an ANSI-colored line, or null */
export function urlAtCol(line: string, col: number): string | null {
	if (!line) return null
	// Check for OSC 8 hyperlinks already in the line
	let i = 0, visCol = 0, currentUri = ''
	while (i < line.length) {
		if (line[i] === '\x1b') {
			const len = readEscapeSequence(line, i)
			const uri = parseOsc8Uri(line.slice(i, i + len))
			if (uri !== null) currentUri = uri
			i += len; continue
		}
		if (visCol === col && currentUri) return currentUri
		visCol++; i++
	}
	// Fall back to regex URL detection on plain text
	const { plain } = stripAnsiMap(line)
	for (const u of findUrlsInPlain(plain)) {
		if (col >= u.start && col < u.end) return u.url
	}
	return null
}

/** Add underline to the text inside an OSC 8 link matching targetUrl */
export function underlineOsc8Link(line: string, targetUrl: string): string {
	let result = ''
	let i = 0
	let inTarget = false

	while (i < line.length) {
		if (line[i] === '\x1b') {
			const len = readEscapeSequence(line, i)
			const seq = line.slice(i, i + len)
			const uri = parseOsc8Uri(seq)
			if (uri !== null) {
				if (inTarget) result += '\x1b[24m'
				result += seq
				inTarget = uri === targetUrl
				if (inTarget) result += '\x1b[4m'
			} else {
				result += seq
			}
			i += len
			continue
		}
		result += line[i]
		i++
	}
	if (inTarget) result += '\x1b[24m'
	return result
}

