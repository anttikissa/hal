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
// automatic height; sending resets it. Enter submits, Shift-Enter is a newline, Alt-Enter queues,
// Escape cancels, Ctrl-D on empty text quits.

import type { Key } from './forms.ts'
import { promptLayout } from './prompt-layout.ts'
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
}

// `queue`: Alt-Enter, run after the turn instead of steering it.
export type PromptAction = { type: 'submit'; text: string; queue?: true } | { type: 'cancel' } | { type: 'quit' }

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

/** Start of the token before pos (spaces skipped). */
function wordLeft(text: string, pos: number): number {
	let segs = [...segmenter.segment(text.slice(0, pos))]
	let i = segs.length
	while (i > 0 && kind(segs[i - 1]!.segment) === 'space') i--
	if (i === 0) return 0
	let k = kind(segs[i - 1]!.segment)
	while (i > 0 && kind(segs[i - 1]!.segment) === k) i--
	return segs[i]!.index
}

/** End of the token after pos (spaces skipped). */
function wordRight(text: string, pos: number): number {
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
	// The insert may merge with its neighbours into one cluster (e.g. a
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

// `width`: the terminal prompt's content width, for moving by visual
// row; without it (the web) rows are the logical lines.
function step(st: PromptState, k: Key, width = Infinity): PromptResult {
	let mod = (k.ctrl ? 'C' : '') + (k.alt ? 'M' : '') + (k.cmd ? 's' : '')
	switch (`${mod}-${k.key}`) {
		case '-up':
			return { state: prompt.vertical(st, -1, width) }
		case '-down':
			return { state: prompt.vertical(st, 1, width) }
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
	let to = (c: number): PromptResult => ({ state: { ...st, cursor: c } })
	switch (`${mod}-${k.key}`) {
		case 'M-up':
			return to(0)
		case 'M-down':
			return to(text.length)
		case 'M-enter':
			if (k.shift) break
			return { state: prompt.cleared(st), action: { type: 'submit', text, queue: true } }
		case '-enter':
			if (k.shift) return { state: prompt.insert(st, '\n') }
			return { state: prompt.cleared(st), action: { type: 'submit', text } }
		case '-escape':
			return { state: st, action: { type: 'cancel' } }
		case 'C-d':
			if (text === '') return { state: st, action: { type: 'quit' } }
			return { state: prompt.remove(st, cursor, prompt.nextBoundary(text, cursor)) }
		case '-delete':
			return { state: prompt.remove(st, cursor, prompt.nextBoundary(text, cursor)) }
		case '-backspace':
			return { state: prompt.remove(st, prompt.prevBoundary(text, cursor), cursor) }
		case 'M-backspace':
			return { state: prompt.remove(st, prompt.wordLeft(text, cursor), cursor) }
		case '-left':
			return to(prompt.prevBoundary(text, cursor))
		case '-right':
			return to(prompt.nextBoundary(text, cursor))
		case 'M-left':
			return to(prompt.wordLeft(text, cursor))
		case 'M-right':
			return to(prompt.wordRight(text, cursor))
		case 's-left':
			return to(0)
		case 's-right':
			return to(text.length)
		case '-home':
		case 'C-a':
			return to(prompt.lineStart(text, cursor))
		case '-end':
		case 'C-e':
			return to(prompt.lineEnd(text, cursor))
		case 'C-k': {
			let end = prompt.lineEnd(text, cursor)
			return { state: prompt.kill(st, cursor, end === cursor ? Math.min(end + 1, text.length) : end) }
		}
		case 'C-u': {
			let start = prompt.lineStart(text, cursor)
			return { state: prompt.kill(st, start === cursor ? Math.max(start - 1, 0) : start, cursor) }
		}
		case 'M-d':
			return { state: prompt.kill(st, cursor, prompt.wordRight(text, cursor)) }
		case 'C-y':
			return { state: st.kill ? prompt.insert(st, st.kill) : st }
		case '-paste':
			return { state: k.text ? prompt.insert(st, k.text) : st }
	}
	if (k.text !== undefined && mod === '') return { state: prompt.insert(st, k.text) }
	return { state: st }
}

export const prompt = {
	empty,
	step,
	vertical,
	autoRows,
	resize,
	insert,
	remove,
	kill,
	cleared,
	boundaries,
	prevBoundary,
	nextBoundary,
	wordLeft,
	wordRight,
	lineStart,
	lineEnd,
}
