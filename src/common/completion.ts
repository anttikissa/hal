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

// Explicit completion fills a declared default for a bare command.
// Otherwise prefix matches complete first, word matches only as a fallback.
// All candidates stay listed from where their shared part last breaks
// (a whole name, a directory's last part), including provider-qualified ids.
function apply(text: string, items: string[]): { text: string; choices?: string[] } {
	let bare = /^\/([a-z][a-z0-9-]*)\s*$/.exec(text)
	let args = bare && commandList.byName(bare[1]!)?.defaultArgs
	let preferred = args === undefined || !bare ? undefined : `/${bare[1]} ${args}`
	if (preferred && items.includes(preferred)) return { text: preferred }
	if (items.length <= 1) return { text: items[0] ?? text }
	let prefix = items.filter((item) => item.startsWith(text))
	let common = (values: string[]) => values.reduce((a, b) => {
		let n = 0
		while (n < a.length && a[n] === b[n]) n++
		return a.slice(0, n)
	})
	let shared = common(items)
	let filled = common(prefix.length ? prefix : items)
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

export const completion = { request, apply }
