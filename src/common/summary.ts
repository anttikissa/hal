// A final answer ends with <summary>one line</summary> (SYSTEM.md, task
// x8): the line a notice or push shows. Clients hide it, including a
// tag still streaming in and a trailing prefix of its opening tag. A
// tag quoted in code (`<summary>`) is text, not a tag.

import { markdownCode } from './markdown-code.ts'

const TAG = '<summary>'
const OPEN = /<summary>/g
const TAGS = /<summary>((?:(?!<summary>)[\s\S])*?)<\/summary>/g

// The summary of `text`: the last complete tag's content, one line.
function extract(text: string): string | undefined {
	let match = [...markdownCode.mask(text).matchAll(TAGS)].at(-1)
	let s = match && text.slice(match.index + TAG.length, match.index + match[0].length - '</summary>'.length).replace(/\s+/g, ' ').trim()
	return s || undefined
}

// `text` without its summary tags, for display.
function strip(text: string): string {
	let masked = markdownCode.mask(text)
	let out = '', at = 0
	for (let match of masked.matchAll(TAGS)) {
		out += text.slice(at, match.index).trimEnd()
		at = match.index + match[0].length
	}
	out += text.slice(at)
	masked = markdownCode.mask(out)
	// An unclosed tag is a summary still streaming in only on the last
	// line: a summary is one line, so a stray tag in prose stays text.
	let open = [...masked.matchAll(OPEN)].at(-1)?.index
	if (open !== undefined && !out.includes('\n', open)) return out.slice(0, open).trimEnd()
	for (let n = TAG.length - 1; n > 0; n--) if (masked.endsWith(TAG.slice(0, n))) return out.slice(0, -n).trimEnd()
	return out.trimEnd()
}

export const summary = { extract, strip }
