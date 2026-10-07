// The prompt editor, shared by the terminal and the web: a pure step
// from (state, key) to a new state plus an optional action for the
// caller (submit, cancel, quit).
//
// The cursor is a UTF-16 offset into text that always sits on a grapheme
// cluster boundary, so movement and deletion act on whole user-perceived
// characters (combining marks, ZWJ emoji, flags).
//
// Keys: Left/Right by grapheme, Alt-Left/Right by word token, Home/End
// and Ctrl-A/E to the line's edges, Cmd-Left/Right to the text's.
// Backspace/Delete/Ctrl-D delete a grapheme, Alt-Backspace a word.
// Ctrl-K/Ctrl-U/Alt-D kill (to line end / line start / word end) into
// `kill`, the client's own buffer (never the system clipboard); Ctrl-Y
// yanks it. Up/Down move by visual row of the layout the terminal
// draws (prompt-layout.ts) at the `width` it passes, keeping a goal
// column; past the top or bottom row they go to the text's start or
// end. Alt-Up/Down go there at once. Ctrl-=/Ctrl-Up grow the
// terminal's box by a row, Ctrl--/Ctrl-Down shrink it back towards its
// automatic height; sending resets it. Enter chords submit as sendKeys binds them, Shift-Enter is a newline,
// Escape cancels, Ctrl-D on empty text quits.
//
// Shift with any move extends a selection from `anchor`; Cmd-A selects
// all; Cmd-X removes the selection (the client copies it first).
// Typing, pasting, Shift-Enter and Ctrl-Y replace it, Backspace
// and Delete delete it, plain Left/Right collapse it. Tab inserts a
// tab, or indents the selected lines; Shift-Tab outdents. Ctrl-/, Cmd-Z
// and Cmd-U undo, with Shift redo (prompt-undo.ts).
// Tasks: 1x, 9x, h9, 8kx.

import { sendKeys } from './send-keys.ts'
import type { Delivery } from './protocol.ts'
import type { Key } from './forms.ts'
import { promptLayout } from './prompt-layout.ts'
import { promptUndo } from './prompt-undo.ts'
import { settings } from './settings.ts'

export interface PromptState {
	text: string
	/** UTF-16 offset, always on a grapheme boundary. */
	cursor: number
	/** The last killed text, for Ctrl-Y. */
	kill?: string
	/** The display column Up/Down aim for, kept across vertical moves. */
	goal?: number
	/** The terminal box's height when resized by hand; else automatic. */
	rows?: number
	/** The terminal box's first visible row. */
	scroll?: number
	/** The selection's fixed end; selected is anchor..cursor. */
	anchor?: number
	/** Undo and redo steps (prompt-undo.ts); sending clears them. */
	undo?: PromptSnapshot[]
	redo?: PromptSnapshot[]
	/** The last key typed a character: the next one joins its undo step. */
	typed?: true
}

export type PromptSnapshot = { text: string; cursor: number; anchor?: number }

// `queue`: Alt-Enter, run after the turn instead of steering it.
export type PromptAction = { type: 'submit'; text: string; delivery: Delivery } | { type: 'cancel' } | { type: 'quit' }

export interface PromptResult {
	state: PromptState
	action?: PromptAction
}

const segmenter = new Intl.Segmenter()

/** Grapheme boundaries of text, including 0 and text.length. */
function boundaries(text: string): number[] {
	let out = [...segmenter.segment(text)].map((s) => s.index)
	out.push(text.length)
	return out
}

function prevBoundary(text: string, pos: number): number {
	let prev = 0
	for (let b of prompt.boundaries(text)) {
		if (b >= pos) break
		prev = b
	}
	return prev
}

function nextBoundary(text: string, pos: number): number {
	for (let b of prompt.boundaries(text)) if (b > pos) return b
	return text.length
}

// Word tokens: letters, digits, marks and _ form words; other
// non-space graphemes form punctuation runs; spaces separate.
function kind(g: string): 'space' | 'word' | 'punct' {
	return /^\s/u.test(g) ? 'space' : /^[\p{L}\p{N}\p{M}_]/u.test(g) ? 'word' : 'punct'
}

// Whitespace words: any run of non-space graphemes. Alt-Backspace and
// Alt-D delete by these, as in the old Hal; moves use tokens.
function bigKind(g: string): 'space' | 'word' {
	return kind(g) === 'space' ? 'space' : 'word'
}

/** Start of the token before pos (spaces skipped). */
function wordLeft(text: string, pos: number, kind: (g: string) => string = prompt.kind): number {
	let segs = [...segmenter.segment(text.slice(0, pos))]
	let i = segs.length
	while (i > 0 && kind(segs[i - 1]!.segment) === 'space') i--
	if (i === 0) return 0
	let k = kind(segs[i - 1]!.segment)
	while (i > 0 && kind(segs[i - 1]!.segment) === k) i--
	return segs[i]!.index
}

/** End of the token after pos (spaces skipped). */
function wordRight(text: string, pos: number, kind: (g: string) => string = prompt.kind): number {
	let segs = [...segmenter.segment(text.slice(pos))]
	let i = 0
	while (i < segs.length && kind(segs[i]!.segment) === 'space') i++
	if (i === segs.length) return text.length
	let k = kind(segs[i]!.segment)
	while (i < segs.length && kind(segs[i]!.segment) === k) i++
	return i === segs.length ? text.length : pos + segs[i]!.index
}

function lineStart(text: string, pos: number): number {
	return pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1
}

function lineEnd(text: string, pos: number): number {
	let end = text.indexOf('\n', pos)
	return end < 0 ? text.length : end
}

function empty(): PromptState {
	return { text: '', cursor: 0 }
}

function insert(st: PromptState, s: string): PromptState {
	let text = st.text.slice(0, st.cursor) + s + st.text.slice(st.cursor)
	let pos = st.cursor + s.length
	// The insert may merge with its neighbors into one cluster (e.g. a
	// regional indicator pairing into a flag); move to the next boundary.
	let cursor = pos === 0 || prompt.boundaries(text).includes(pos) ? pos : prompt.nextBoundary(text, pos)
	return { ...st, text, cursor }
}

function remove(st: PromptState, from: number, to: number): PromptState {
	return { ...st, text: st.text.slice(0, from) + st.text.slice(to), cursor: from }
}

// Removes [from, to) into the kill buffer; an empty range keeps it.
function kill(st: PromptState, from: number, to: number): PromptState {
	return from === to ? st : { ...prompt.remove(st, from, to), kill: st.text.slice(from, to) }
}

// Pasted text as typed: CRLF and CR become LF, and control characters
// other than tab and newline go.
function clean(text: string): string {
	return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

// Sending empties the prompt and resets the box; the kill buffer stays.
function cleared(st: PromptState): PromptState {
	return st.kill === undefined ? prompt.empty() : { ...prompt.empty(), kill: st.kill }
}

// Up (-1) or Down (1) one visual row, aiming for the goal column.
function vertical(st: PromptState, dir: -1 | 1, width: number): PromptState {
	let rows = promptLayout.rows(st.text, width)
	let { row, col } = promptLayout.position(st.text, rows, st.cursor)
	let goal = st.goal ?? col
	let target = row + dir
	let cursor = target < 0 ? 0 : target >= rows.length ? st.text.length : promptLayout.offsetAt(st.text, rows, target, goal)
	return { ...st, cursor, goal }
}

// The box's height at `width` unless resized: all rows, up to the setting.
function autoRows(st: PromptState, width: number): number {
	return promptLayout.autoHeight(promptLayout.rows(st.text, width).length, settings.promptRows())
}

function resize(st: PromptState, dir: -1 | 1, width: number): PromptState {
	let auto = prompt.autoRows(st, width)
	let rows = Math.max(auto, (st.rows ?? auto) + dir)
	let { rows: _, ...rest } = st
	return rows === auto ? rest : { ...rest, rows }
}

// Shift-Tab (`out`) removes one indent level (a tab, one to four
// spaces, or up to three spaces and a tab) from the selected lines or
// the cursor's; Tab adds a tab to the selected ones and the selection
// grows to take in the first. A line the selection end touches only at
// its first column is left out, unless the cursor rests there.
function indent(st: PromptState, out: boolean): PromptState {
	let { text, cursor } = st
	let sel = prompt.selection(st)
	let first = prompt.lineStart(text, sel?.start ?? cursor)
	let end = sel?.end ?? cursor
	if (sel && text[end - 1] === '\n' && end !== cursor) end--
	let last = prompt.lineEnd(text, end)
	let before = text.slice(first, last)
	let pattern = out ? /^(?: {1,3}\t| {1,4}|\t)/gm : /^/gm
	let put = out ? '' : '\t'
	let after = before.replace(pattern, put)
	if (after === before) return st
	let map = (o: number) =>
		o < first ? o : o >= last ? o + after.length - before.length : first + before.slice(0, o - first).replace(pattern, put).length
	let next: PromptState = { ...st, text: text.slice(0, first) + after + text.slice(last), cursor: map(cursor) }
	if (st.anchor !== undefined) next.anchor = map(st.anchor)
	if (!out && sel) {
		if (next.anchor! < next.cursor) next.anchor = first
		else next.cursor = first
	}
	return next
}

// The selected range, if the anchor and cursor differ.
function selection(st: PromptState): { start: number; end: number } | undefined {
	let a = st.anchor
	if (a === undefined || a === st.cursor || a > st.text.length) return undefined
	return { start: Math.min(a, st.cursor), end: Math.max(a, st.cursor) }
}

function withoutTyped(st: PromptState): PromptState {
	if (!st.typed) return st
	let { typed: _, ...rest } = st
	return rest
}

// `width`: the terminal prompt's content width, for moving by visual
// row; without it (the web) rows are the logical lines. Every edit is
// one undo step (promptUndo), except that typed characters in a row
// make one.
function step(st: PromptState, k: Key, width = Infinity): PromptResult {
	let mod = (k.ctrl ? 'C' : '') + (k.alt ? 'M' : '') + (k.cmd ? 's' : '')
	let name = `${mod}-${k.key}`
	if (name === 'C-/' || name === 's-z' || name === 's-u') return { state: prompt.withoutTyped(promptUndo.undo(st, !!k.shift)) }
	let r = prompt.apply(st, k, width)
	if (r.action?.type === 'submit') return r
	let typed = k.text !== undefined && mod === '' && k.key !== 'paste'
	let state = r.state
	if (state.text !== st.text && !(typed && st.typed)) state = promptUndo.record(state, st)
	state = typed && state.text !== st.text ? { ...state, typed: true } : prompt.withoutTyped(state)
	return r.action ? { state, action: r.action } : { state }
}

// One key without undo: moves (Shift extends the selection from its
// anchor), edits (replacing or deleting the selection) and actions.
function apply(st: PromptState, k: Key, width: number): PromptResult {
	let mod = (k.ctrl ? 'C' : '') + (k.alt ? 'M' : '') + (k.cmd ? 's' : '')
	let move = (s: PromptState): PromptState => {
		let { anchor: _, ...rest } = s
		return k.shift ? { ...rest, anchor: st.anchor ?? st.cursor } : rest
	}
	switch (`${mod}-${k.key}`) {
		case '-up':
			return { state: move(prompt.vertical(st, -1, width)) }
		case '-down':
			return { state: move(prompt.vertical(st, 1, width)) }
		case 'C-=':
		case 'C-up':
			return { state: prompt.resize(st, 1, width) }
		case 'C--':
		case 'C-down':
			return { state: prompt.resize(st, -1, width) }
	}
	// Any other key forgets the goal column.
	if (st.goal !== undefined) {
		let { goal: _, ...rest } = st
		st = rest
	}
	let { text, cursor } = st
	let sel = prompt.selection(st)
	let { anchor: _, ...base } = st
	// What typing, pasting and deleting start from: the selection gone.
	let cut = sel ? prompt.remove(base, sel.start, sel.end) : base
	let to = (c: number): PromptResult => ({ state: move({ ...st, cursor: c }) })
	let del = (from: number, until: number): PromptResult => ({ state: sel ? cut : prompt.remove(base, from, until) })
	// Enter chords send as sendKeys says (tasks csn, 8kx); Shift-Enter is a newline.
	if (k.key === 'enter' && k.shift && mod === '') return { state: prompt.insert(cut, '\n') }
	let delivery = k.key === 'enter' && !k.shift ? sendKeys.delivery(k) : undefined
	if (delivery) return { state: prompt.cleared(st), action: { type: 'submit', text, delivery } }
	switch (`${mod}-${k.key}`) {
		case 'M-up':
			return to(0)
		case 'M-down':
			return to(text.length)
		case '-escape':
			return { state: st, action: { type: 'cancel' } }
		case 'C-d':
			if (text === '') return { state: st, action: { type: 'quit' } }
			return del(cursor, prompt.nextBoundary(text, cursor))
		case '-delete':
			return del(cursor, prompt.nextBoundary(text, cursor))
		case '-backspace':
			return del(prompt.prevBoundary(text, cursor), cursor)
		case 'M-backspace':
			return del(prompt.wordLeft(text, cursor, prompt.bigKind), cursor)
		case '-left':
			return sel && !k.shift ? { state: { ...base, cursor: sel.start } } : to(prompt.prevBoundary(text, cursor))
		case '-right':
			return sel && !k.shift ? { state: { ...base, cursor: sel.end } } : to(prompt.nextBoundary(text, cursor))
		case 'M-left':
			return to(prompt.wordLeft(text, cursor))
		case 'M-right':
			return to(prompt.wordRight(text, cursor))
		case 's-left':
			return to(0)
		case 's-right':
			return to(text.length)
		case 's-a':
			return { state: { ...base, anchor: 0, cursor: text.length } }
		case '-home':
		case 'C-a':
			return to(prompt.lineStart(text, cursor))
		case '-end':
		case 'C-e':
			return to(prompt.lineEnd(text, cursor))
		case 'C-k': {
			let end = prompt.lineEnd(text, cursor)
			return { state: prompt.kill(base, cursor, end === cursor ? Math.min(end + 1, text.length) : end) }
		}
		case 'C-u': {
			let start = prompt.lineStart(text, cursor)
			return { state: prompt.kill(base, start === cursor ? Math.max(start - 1, 0) : start, cursor) }
		}
		case 'M-d':
			// Alt-D deletes a selection (not into the kill buffer).
			return { state: sel ? cut : prompt.kill(base, cursor, prompt.wordRight(text, cursor, prompt.bigKind)) }
		case 'C-y':
			return { state: st.kill ? prompt.insert(cut, st.kill) : st }
		case '-paste': {
			let pasted = prompt.clean(k.text ?? '')
			return { state: pasted ? prompt.insert(cut, pasted) : st }
		}
		case 's-x':
			return { state: sel ? cut : st }
		case '-tab':
			if (k.shift || sel) return { state: prompt.indent(st, !!k.shift) }
			return { state: prompt.insert(base, '\t') }
	}
	if (k.text !== undefined && mod === '') return { state: prompt.insert(cut, k.text) }
	return { state: st }
}

export const prompt = {
	empty,
	step,
	apply,
	selection,
	indent,
	withoutTyped,
	vertical,
	autoRows,
	resize,
	insert,
	remove,
	kill,
	cleared,
	clean,
	boundaries,
	prevBoundary,
	nextBoundary,
	wordLeft,
	kind,
	bigKind,
	wordRight,
	lineStart,
	lineEnd,
}
