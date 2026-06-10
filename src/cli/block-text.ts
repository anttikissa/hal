// Text preparation for block rendering — control-byte sanitization, ANSI
// escape stripping, and OSC 8 hyperlinking of plain URLs (including URLs
// hard-wrapped across multiple visual lines).

import { visLen } from '../utils/strings.ts'

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

const URL_RE = /https?:\/\/[^\s<>"']+/g
const TRAILING_URL_PUNCT = '.,!?;:)]}'

function firstWhitespaceIndex(s: string): number {
	for (let i = 0; i < s.length; i++) {
		if (/\s/.test(s[i]!)) return i
	}
	return -1
}

function trimTrailingUrlPunctuation(url: string, spans: LinkSpan[]): string {
	while (url && TRAILING_URL_PUNCT.includes(url.at(-1)!)) {
		url = url.slice(0, -1)
		const last = spans.at(-1)
		if (!last) break
		last.end--
		if (last.end <= last.start) spans.pop()
	}
	return url
}

function pushUrlSpans(spans: LinkSpan[], lines: string[], lineIndex: number, start: number, end: number, cols: number): void {
	let url = lines[lineIndex]!.slice(start, end)
	const urlSpans: LinkSpan[] = [{ line: lineIndex, start, end, url: '' }]
	let currentLine = lineIndex
	let currentEnd = end

	while (currentEnd === lines[currentLine]!.length && visLen(lines[currentLine]!) >= cols && currentLine + 1 < lines.length) {
		const next = lines[currentLine + 1]!
		if (!next || /^\s/.test(next) || /^https?:\/\//.test(next)) break
		const whitespace = firstWhitespaceIndex(next)
		if (whitespace >= 0) break
		url += next
		urlSpans.push({ line: currentLine + 1, start: 0, end: next.length, url: '' })
		currentLine++
		currentEnd = next.length
	}

	url = trimTrailingUrlPunctuation(url, urlSpans)
	if (!url || url === 'http://' || url === 'https://') return
	for (const span of urlSpans) {
		span.url = url
		spans.push(span)
	}
}

function osc8(url: string, label: string): string {
	return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`
}

function hyperlinkUrls(lines: string[], cols: number): string[] {
	const spans: LinkSpan[] = []
	for (let i = 0; i < lines.length; i++) {
		URL_RE.lastIndex = 0
		let match: RegExpExecArray | null
		while ((match = URL_RE.exec(lines[i]!))) {
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
