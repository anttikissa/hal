// Tab completion of slash commands (tasks/w4/forms.md, Commands). The
// host completes, against its own files and commands, so every client
// (terminal, web, remote) gets the same answers; this is what a client
// does with them, the same in both.

import { commandList } from './commands/list.ts'

// The command asking the host to complete `text`; only a slash command
// is completed.
function request(sessionId: string, text: string): unknown {
	return text.startsWith('/') ? { type: 'complete', sessionId, text } : undefined
}

// Explicit completion fills a declared default for a bare command, if
// `fillDefault`. Otherwise prefix matches complete first, word matches
// only as a fallback.
// All candidates stay listed from where their shared part last breaks
// (a whole name, a directory's last part), including provider-qualified ids.
function apply(text: string, items: string[], fillDefault = true): { text: string; choices?: string[] } {
	let bare = /^\/([a-z][a-z0-9-]*)\s*$/.exec(text)
	let args = bare && fillDefault ? commandList.byName(bare[1]!)?.defaultArgs : undefined
	let preferred = args === undefined ? undefined : `/${bare![1]} ${args}`
	if (preferred && items.includes(preferred)) return { text: preferred }
	if (items.length <= 1) return { text: items[0] ?? text }
	let prefix = items.filter((item) => item.startsWith(text))
	let shared = completion.common(items)
	let filled = completion.common(prefix.length ? prefix : items)
	// Cut where the shared part last breaks (a space or /), so a name
	// with spaces stays whole and a path shows its last part.
	let cut = Math.max(shared.lastIndexOf(' '), shared.lastIndexOf('/')) + 1
	let choices = items.map((item) => {
		let s = item.trimEnd()
		if (!s.includes(' ')) return s
		return s.slice(cut) || s.slice(Math.max(s.lastIndexOf(' '), s.slice(0, -1).lastIndexOf('/')) + 1)
	})
	return { text: filled.length > text.length ? filled : text, choices }
}

// Prefix matches sharing a next "/" collapse into that prefix, like a
// shell listing folders; its description counts them. `groups`: the
// values that are groups.
function group(
	text: string,
	items: string[],
	descriptions?: string[],
): { items: string[]; descriptions?: string[]; groups: string[] } {
	let prefix = items.filter((item) => item.startsWith(text))
	if (prefix.length < 2) return { items, descriptions, groups: [] }
	let base = completion.common(prefix).length
	let key = (item: string) => {
		let slash = item.startsWith(text) ? item.indexOf('/', base) : -1
		return slash < 0 ? item : item.slice(0, slash + 1)
	}
	let counts = new Map<string, number>()
	for (let item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
	let out = new Map<string, string>()
	items.forEach((item, i) => {
		let n = counts.get(key(item))!
		if (n < 2) out.set(item, descriptions?.[i] ?? '')
		else if (!out.has(key(item))) out.set(key(item), `${n} choices`)
	})
	let groups = [...out.keys()].filter((k) => counts.get(k)! > 1)
	if (!groups.length) return { items, descriptions, groups }
	return { items: [...out.keys()], descriptions: [...out.values()], groups }
}

// The longest prefix all of `values` share.
function common(values: string[]): string {
	return values.reduce((a, b) => {
		let n = 0
		while (n < a.length && a[n] === b[n]) n++
		return a.slice(0, n)
	})
}

export const completion = { request, apply, group, common }
