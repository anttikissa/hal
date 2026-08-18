// Text preparation for block rendering — control-byte sanitization, ANSI
// escape stripping, and OSC 8 hyperlinking of plain URLs (including URLs
// hard-wrapped across multiple visual lines).

import { visLen } from '../../utils/strings.ts'

function sanitizeTerminalText(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (ch) => {
		if (ch === '\n' || ch === '\t') return ch
		if (ch === '\r') return '␍'
		if (ch === '\x1b') return '␛'
		return `␀${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
	})
}

function stripAnsiSequences(text: string): string {
	let out = ''
	for (let i = 0; i < text.length; ) {
		const ch = text[i]!
		if (ch !== '\x1b') {
			out += ch
			i++
			continue
		}
		const next = text[i + 1]
		if (!next) break
		if (next === '[') {
			i += 2
			while (i < text.length) {
				const code = text.charCodeAt(i++)
				if (code >= 0x40 && code <= 0x7e) break
			}
			continue
		}
		if (next === ']') {
			i += 2
			while (i < text.length) {
				if (text[i] === '\x07') {
					i++
					break
				}
				if (text[i] === '\x1b' && text[i + 1] === '\\') {
					i += 2
					break
				}
				i++
			}
			continue
		}
		i += 2
	}
	return out
}

interface LinkSpan { line: number; start: number; end: number; url: string }

const URL_RE = /https?:\/\/[^\s<>"'\x1b]+/g
const TRAILING_URL_PUNCT = '.,!?;:)]}'

function firstWhitespaceIndex(s: string): number {
	for (let i = 0; i < s.length; i++) {
		if (/\s/.test(s[i]!)) return i
	}
	return -1
}

function ansiSequenceEnd(s: string, start: number): number {
	if (s[start] !== '\x1b') return start
	if (s[start + 1] === '[') {
		let i = start + 2
		while (i < s.length) {
			const code = s.charCodeAt(i++)
			if (code >= 0x40 && code <= 0x7e) return i
		}
		return s.length
	}
	if (s[start + 1] === ']') {
		let i = start + 2
		while (i < s.length) {
			if (s[i] === '\x07') return i + 1
			if (s[i] === '\x1b' && s[i + 1] === '\\') return i + 2
			i++
		}
		return s.length
	}
	return Math.min(s.length, start + 2)
}

function hasOnlyAnsiAfter(s: string, start: number): boolean {
	for (let i = start; i < s.length;) {
		if (s[i] !== '\x1b') return false
		i = ansiSequenceEnd(s, i)
	}
	return true
}

function lastPrintableStart(s: string, start: number, end: number): number {
	let last = -1
	for (let i = start; i < end;) {
		if (s[i] === '\x1b') {
			i = ansiSequenceEnd(s, i)
			continue
		}
		last = i
		i += s.codePointAt(i)! > 0xffff ? 2 : 1
	}
	return last
}

function trimTrailingUrlPunctuation(url: string, spans: LinkSpan[], lines: string[]): string {
	while (url && TRAILING_URL_PUNCT.includes(url.at(-1)!)) {
		url = url.slice(0, -1)
		const last = spans.at(-1)
		if (!last) break
		last.end = lastPrintableStart(lines[last.line]!, last.start, last.end)
		if (last.end <= last.start) spans.pop()
	}
	return url
}

function pushUrlSpans(spans: LinkSpan[], lines: string[], lineIndex: number, start: number, end: number, cols: number): void {
	let url = stripAnsiSequences(lines[lineIndex]!.slice(start, end))
	const urlSpans: LinkSpan[] = [{ line: lineIndex, start, end, url: '' }]
	let currentLine = lineIndex
	let currentEnd = end

	// Markdown styling adds SGR sequences at each visual-row boundary. They are
	// part of the visible label, never the hyperlink destination.
	while (hasOnlyAnsiAfter(lines[currentLine]!, currentEnd) && visLen(lines[currentLine]!) >= cols && currentLine + 1 < lines.length) {
		const next = lines[currentLine + 1]!
		const plainNext = stripAnsiSequences(next)
		if (!plainNext || /^\s/.test(plainNext) || /^https?:\/\//.test(plainNext)) break
		const whitespace = firstWhitespaceIndex(plainNext)
		if (whitespace >= 0) break
		url += plainNext
		urlSpans.push({ line: currentLine + 1, start: 0, end: next.length, url: '' })
		currentLine++
		currentEnd = next.length
	}

	url = trimTrailingUrlPunctuation(url, urlSpans, lines)
	if (!url || url === 'http://' || url === 'https://') return
	for (const span of urlSpans) {
		span.url = url
		spans.push(span)
	}
}

function osc8(url: string, label: string): string {
	return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`
}

function insideOsc8Link(line: string, index: number): boolean {
	const start = line.lastIndexOf('\x1b]8;;', index)
	if (start < 0) return false
	const end = line.indexOf('\x07', start)
	if (end < 0 || index < end) return true
	return line.slice(start + 5, end) !== ''
}

function hyperlinkUrls(lines: string[], cols: number): string[] {
	const spans: LinkSpan[] = []
	for (let i = 0; i < lines.length; i++) {
		URL_RE.lastIndex = 0
		let match: RegExpExecArray | null
		while ((match = URL_RE.exec(lines[i]!))) {
			if (insideOsc8Link(lines[i]!, match.index)) continue
			pushUrlSpans(spans, lines, i, match.index, match.index + match[0].length, cols)
		}
	}
	if (spans.length === 0) return lines

	const byLine = new Map<number, LinkSpan[]>()
	for (const span of spans) {
		const lineSpans = byLine.get(span.line) ?? []
		lineSpans.push(span)
		byLine.set(span.line, lineSpans)
	}

	const linked = lines.slice()
	for (const [lineIndex, lineSpans] of byLine) {
		lineSpans.sort((a, b) => b.start - a.start)
		let line = linked[lineIndex]!
		for (const span of lineSpans) {
			line = line.slice(0, span.start) + osc8(span.url, line.slice(span.start, span.end)) + line.slice(span.end)
		}
		linked[lineIndex] = line
	}
	return linked
}

export const blockText = {
	sanitizeTerminalText,
	stripAnsiSequences,
	hyperlinkUrls,
}
