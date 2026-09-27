/// <reference lib="dom" />
// The message box's editing keys. The textarea keeps native typing,
// IME, selection, clipboard, undo and the moves that already match
// Hal's (arrows, Option/Alt word moves, Home/End, Backspace). The keys
// in `table` mean something else in Hal (readline kills and yank, which
// the browser either lacks or binds elsewhere), so app.key runs them
// through the shared editor (src/common/prompt.ts) and `write` puts the
// result back. Enter, Alt-Enter and Escape are app.key's own.
//
// Write-back uses execCommand('insertText'), which keeps the edit on the
// browser's undo stack (Cmd-Z undoes a kill); setting .value would wipe
// it. setRangeText is the fallback where execCommand is unavailable.

import type { Key } from '../common/forms.ts'

// Keys routed through prompt.step: key name and its exact modifiers.
const table: { key: string; ctrl?: true; alt?: true }[] = [
	{ key: 'k', ctrl: true },
	{ key: 'u', ctrl: true },
	{ key: 'y', ctrl: true },
	{ key: 'd', alt: true },
]

function routed(k: Key): boolean {
	return editor.table.some((t) => t.key === k.key && !!t.ctrl === !!k.ctrl && !!t.alt === !!k.alt && !k.cmd)
}

export type Splice = { start: number; end: number; text: string }

const low = (s: string, i: number) => /[\uDC00-\uDFFF]/.test(s[i] ?? '')

// The smallest replacement turning `before` into `after`, never
// splitting a surrogate pair.
function splice(before: string, after: string): Splice {
	let p = 0
	let max = Math.min(before.length, after.length)
	while (p < max && before[p] === after[p]) p++
	if (p > 0 && (low(before, p) || low(after, p))) p--
	let s = 0
	while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++
	if (s > 0 && (low(before, before.length - s) || low(after, after.length - s))) s--
	return { start: p, end: before.length - s, text: after.slice(p, after.length - s) }
}

// Applies an edit to the textarea as if typed, then puts the caret at `cursor`.
function write(box: HTMLTextAreaElement, edit: Splice, cursor: number): void {
	box.focus()
	box.setSelectionRange(edit.start, edit.end)
	let done = document.execCommand(edit.text ? 'insertText' : 'delete', false, edit.text)
	if (!done) {
		box.setRangeText(edit.text, edit.start, edit.end)
		box.dispatchEvent(new Event('input', { bubbles: true }))
	}
	box.setSelectionRange(cursor, cursor)
}

export const editor = {
	table,
	routed,
	splice,
	write,
}
