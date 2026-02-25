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

/** Trim trailing punctuation and unbalanced brackets from a URL */
function trimUrlEnd(url: string): string {
	let end = url.length
	while (end > 0) {
		const ch = url[end - 1]
		if (ch === '.' || ch === ',' || ch === ';' || ch === ':' || ch === '!' || ch === '?') {
			end--
			continue
		}
		if (ch === ')' && countChar(url, ')', end) > countChar(url, '(', end)) {
			end--
			continue
		}
		if (ch === ']' && countChar(url, ']', end) > countChar(url, '[', end)) {
			end--
			continue
		}
		if (ch === "'" || ch === '"') {
			end--
			continue
		}
		if (ch === '>') {
			end--
			continue
		}
		break
	}
	return url.slice(0, end)
}

/**
 * Wrap URLs in an ANSI-colored line with OSC 8 hyperlink sequences.
 * Skips lines that already contain OSC 8.
 */
export function linkifyLine(line: string): string {
	if (!line) return line
	// Already has OSC 8 — don't double-linkify
	if (line.includes('\x1b]8;')) return line

	// Build plain text + position map
	const plainChars: string[] = []
	const posMap: number[] = [] // posMap[plainIndex] = index in original line
	let i = 0
	while (i < line.length) {
		if (line[i] === '\x1b') {
			const len = readEscapeSequence(line, i)
			i += len
			continue
		}
		posMap.push(i)
		plainChars.push(line[i])
		i++
	}
	const plainText = plainChars.join('')

	// Find URLs in plain text
	URL_RE.lastIndex = 0
	const urls: { start: number; end: number; url: string }[] = []
	let match
	while ((match = URL_RE.exec(plainText)) !== null) {
		const raw = match[0]
		const trimmed = trimUrlEnd(raw)
		urls.push({ start: match.index, end: match.index + trimmed.length, url: trimmed })
	}
	if (urls.length === 0) return line

	// Insert OSC 8 sequences at mapped positions
	let result = ''
	let lastOrigEnd = 0
	for (const u of urls) {
		const origStart = posMap[u.start]
		// origEnd: position after last char of the URL in original line
		const origEnd =
			u.end < posMap.length
				? posMap[u.end]
				: // URL extends to end of visible text; include remaining ANSI trailing sequences
					line.length
		result += line.slice(lastOrigEnd, origStart)
		result += `\x1b]8;;${u.url}\x1b\\`
		result += line.slice(origStart, origEnd)
		result += OSC8_CLOSE
		lastOrigEnd = origEnd
	}
	result += line.slice(lastOrigEnd)
	return result
}
