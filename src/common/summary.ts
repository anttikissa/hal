// A final answer ends with <summary>one line</summary> (SYSTEM.md, task
// x8): the line a notice or push shows. Clients hide it, including a
// tag still streaming in and a trailing prefix of its opening tag.

const TAG = '<summary>'

// The summary of `text`: the last complete tag's content, one line.
function extract(text: string): string | undefined {
	let all = [...text.matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
	let s = all.at(-1)?.[1]?.replace(/\s+/g, ' ').trim()
	return s || undefined
}

// `text` without its summary tags, for display.
function strip(text: string): string {
	let out = text.replace(/\s*<summary>[\s\S]*?<\/summary>/g, '')
	let open = out.lastIndexOf(TAG)
	if (open >= 0) return out.slice(0, open).trimEnd()
	for (let n = TAG.length - 1; n > 0; n--) if (out.endsWith(TAG.slice(0, n))) return out.slice(0, -n).trimEnd()
	return out.trimEnd()
}

export const summary = { extract, strip }
