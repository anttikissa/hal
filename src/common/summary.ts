// A final answer ends with <summary>one line</summary> (SYSTEM.md, task
// x8): the line a notice or push shows. A reply that asks the user ends
// with <question>one line</question> instead (task nd6): its turn waits
// for the user. Clients show questions inline (nd6), hide summary metadata
// and incomplete tags, and show a summary-only answer (a1k).
// A tag quoted in code (`<summary>`) is text, not a tag.

import { markdownCode } from './markdown-code.ts'
import { names } from './names.ts'

const NAMES = ['summary', 'question'] as const
export type TagKind = (typeof NAMES)[number]
const OPEN = /<(summary|question)>/g
const TAGS = /<(summary|question)>((?:(?!<(?:summary|question)>)[\s\S])*?)<\/\1>/g

// The last complete tag of `text`: its kind and content, one line.
function last(text: string): { kind: TagKind; line: string } | undefined {
	let match = [...markdownCode.mask(text).matchAll(TAGS)].at(-1)
	if (!match) return undefined
	let kind = match[1] as TagKind
	let line = text.slice(match.index + kind.length + 2, match.index + match[0].length - kind.length - 3).replace(/\s+/g, ' ').trim()
	return line ? { kind, line } : undefined
}

// The summary or question line of `text`.
function extract(text: string): string | undefined {
	return last(text)?.line
}

// Whether `text` ends its reply by asking the user (a <question> tag last).
function asks(text: string): boolean {
	return last(text)?.kind === 'question'
}

// Remove notification metadata; answers retain question content.
function strip(text: string, questions = false): string {
	let masked = markdownCode.mask(text)
	let out = '', at = 0
	for (let match of masked.matchAll(TAGS)) {
		if (questions && match[1] === 'question') {
			out += text.slice(at, match.index) + text.slice(match.index + '<question>'.length, match.index + match[0].length - '</question>'.length)
		} else out += text.slice(at, match.index).trimEnd()
		at = match.index + match[0].length
	}
	out += text.slice(at)
	masked = markdownCode.mask(out)
	// An unclosed tag is a line still streaming in only on the last
	// line: a summary is one line, so a stray tag in prose stays text.
	let open = [...masked.matchAll(OPEN)].at(-1)?.index
	if (open !== undefined && !out.includes('\n', open)) return out.slice(0, open).trimEnd()
	for (let name of NAMES) {
		let tag = `<${name}>`
		for (let n = tag.length - 1; n > 0; n--) if (masked.endsWith(tag.slice(0, n))) return out.slice(0, -n).trimEnd()
	}
	return out.trimEnd()
}

// Hide redundant notification text, never an answer's only visible content.
function answer(text: string): string {
	let body = names.strip(summary.strip(text, true))
	return body.trim() ? body : summary.extract(text) ?? body
}

export const summary = { extract, asks, strip, answer }
