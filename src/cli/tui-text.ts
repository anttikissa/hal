const RESET = '\x1b[0m'
const OSC8_CLOSE = '\x1b]8;;\x1b\\'

// Schemes from Ghostty's url.zig
const URL_RE =
	/(?:https?:\/\/|ftp:\/\/|ssh:\/\/|git:\/\/|file:\/\/?|mailto:|tel:\+?|magnet:\?|ipfs:\/\/|ipns:\/\/|gemini:\/\/|gopher:\/\/|news:)\S+/g

/** Word-wrap a plain string into lines of at most `width` chars, breaking at spaces */
export function wordWrapLines(text: string, width: number): string[] {
	if (width <= 0) return [text]
	const result: string[] = []
	for (const segment of text.split('\n')) {
		let remaining = segment
		while (remaining.length > width) {
			let breakAt = remaining.lastIndexOf(' ', width)
			if (breakAt <= 0) breakAt = width
			result.push(remaining.slice(0, breakAt))
			remaining =
				remaining[breakAt] === ' ' ? remaining.slice(breakAt + 1) : remaining.slice(breakAt)
		}
		result.push(remaining)
	}
	return result
}

export function readEscapeSequence(line: string, start: number): number {
	if (line[start] !== '\x1b') return 0
	const next = line[start + 1]
	if (!next) return 1
	if (next === '[') {
		for (let i = start + 2; i < line.length; i++) {
			const code = line.charCodeAt(i)
			if (code >= 0x40 && code <= 0x7e) return i - start + 1
		}
		return line.length - start
	}
	if (next === ']') {
		for (let i = start + 2; i < line.length; i++) {
			if (line[i] === '\x07') return i - start + 1
			if (line[i] === '\x1b' && line[i + 1] === '\\') return i - start + 2
		}
		return line.length - start
	}
	return 2
}

/** Extract OSC 8 URI from an escape sequence, or null if not OSC 8 */
function parseOsc8Uri(seq: string): string | null {
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

/** Truncate an ANSI-colored line to maxCols visible characters */
export function truncateAnsi(line: string, maxCols: number): string {
	if (maxCols <= 0 || !line) return ''
	let out = ''
	let visCols = 0
	let i = 0
	let sawAnsi = false
	let inLink = false
	while (i < line.length && visCols < maxCols) {
		if (line[i] === '\x1b') {
			const seqLen = readEscapeSequence(line, i)
			const seq = line.slice(i, i + seqLen)
			out += seq
			i += seqLen
			sawAnsi = true
			const uri = parseOsc8Uri(seq)
			if (uri !== null) inLink = uri.length > 0
			continue
		}
		out += line[i]
		visCols++
		i++
	}
	if (sawAnsi) {
		if (inLink) out += OSC8_CLOSE
		out += RESET
	}
	return out
}

/**
 * Word-wrap an ANSI-colored logical line into visual lines.
 * Preserves ANSI + OSC 8 hyperlink state across wraps.
 */
export function wrapAnsi(line: string, maxCols: number): string[] {
	if (maxCols <= 0) return ['']
	if (!line) return ['']

	const result: string[] = []
	let current = ''
	let visCols = 0
	let i = 0
	let activeAnsi = ''
	let activeLink = '' // OSC 8 hyperlink URI (empty = no link)

	// Word-wrap break point tracking
	let lastSpaceI = -1
	let lastSpaceCols = -1
	let lastSpaceCurrent = ''
	let lastSpaceAnsi = ''
	let lastSpaceLink = ''

	while (i < line.length) {
		if (line[i] === '\x1b') {
			const seqLen = readEscapeSequence(line, i)
			const seq = line.slice(i, i + seqLen)
			current += seq
			if (seq.startsWith('\x1b[') && seq.endsWith('m')) {
				if (seq === '\x1b[0m') activeAnsi = ''
				else activeAnsi += seq
			}
			const uri = parseOsc8Uri(seq)
			if (uri !== null) activeLink = uri
			i += seqLen
			continue
		}

		if (line[i] === ' ') {
			lastSpaceI = i + 1
			lastSpaceCols = visCols + 1
			lastSpaceCurrent = current + ' '
			lastSpaceAnsi = activeAnsi
			lastSpaceLink = activeLink
		}

		if (visCols >= maxCols) {
			// Try word break
			if (lastSpaceCols > 0 && lastSpaceCols > maxCols * 0.3) {
				if (lastSpaceLink) lastSpaceCurrent += OSC8_CLOSE
				result.push(lastSpaceCurrent + RESET)
				activeAnsi = lastSpaceAnsi
				activeLink = lastSpaceLink
				current = activeAnsi
				if (activeLink) current += `\x1b]8;;${activeLink}\x1b\\`
				visCols = 0
				i = lastSpaceI
				lastSpaceI = -1
				lastSpaceCols = -1
				lastSpaceCurrent = ''
				lastSpaceAnsi = ''
				lastSpaceLink = ''
				continue
			}
			// Hard break
			if (activeLink) current += OSC8_CLOSE
			result.push(current + RESET)
			current = activeAnsi
			if (activeLink) current += `\x1b]8;;${activeLink}\x1b\\`
			visCols = 0
			lastSpaceI = -1
			lastSpaceCols = -1
			lastSpaceCurrent = ''
			lastSpaceAnsi = ''
			lastSpaceLink = ''
			continue
		}

		current += line[i]
		visCols++
		i++
	}

	result.push(current)
	return result
}

// ── OSC 8 Hyperlink Detection ──

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

export function parseKeys(data: string, pasteStart: string, pasteEnd: string): string[] {
	const keys: string[] = []
	let i = 0
	while (i < data.length) {
		if (data.startsWith(pasteStart, i)) {
			const contentStart = i + pasteStart.length
			const endIdx = data.indexOf(pasteEnd, contentStart)
			if (endIdx >= 0) {
				const pasted = data.slice(contentStart, endIdx)
				if (pasted) keys.push(pasted)
				i = endIdx + pasteEnd.length
			} else {
				const pasted = data.slice(contentStart)
				if (pasted) keys.push(pasted)
				i = data.length
			}
			continue
		}
		if (data[i] === '\x1b') {
			if (i + 1 < data.length && (data[i + 1] === '[' || data[i + 1] === 'O')) {
				let j = i + 2
				while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f)
					j++
				if (j < data.length) j++
				keys.push(data.slice(i, j))
				i = j
			} else if (i + 1 < data.length) {
				keys.push(data.slice(i, i + 2))
				i += 2
			} else {
				keys.push('\x1b')
				i++
			}
		} else {
			keys.push(data[i])
			i++
		}
	}
	return keys
}

export function wordBoundaryLeft(buf: string, cursor: number): number {
	let i = cursor
	while (i > 0 && buf[i - 1] === ' ') i--
	while (i > 0 && buf[i - 1] !== ' ') i--
	return i
}

export function wordBoundaryRight(buf: string, cursor: number): number {
	let i = cursor
	while (i < buf.length && buf[i] !== ' ') i++
	while (i < buf.length && buf[i] === ' ') i++
	return i
}
