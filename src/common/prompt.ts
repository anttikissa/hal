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
// yanks it. Enter submits, Shift-Enter is a newline, Alt-Enter queues,
// Escape cancels, Ctrl-D on empty text quits.

import type { Key } from './forms.ts'

export interface PromptState {
	text: string
	/** UTF-16 offset, always on a grapheme boundary. */
	cursor: number
	/** The last killed text, for Ctrl-Y. */
	kill?: string
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

function cleared(st: PromptState): PromptState {
	return st.kill === undefined ? prompt.empty() : { ...prompt.empty(), kill: st.kill }
}

function step(st: PromptState, k: Key): PromptResult {
	let { text, cursor } = st
	let mod = (k.ctrl ? 'C' : '') + (k.alt ? 'M' : '') + (k.cmd ? 's' : '')
	let to = (c: number): PromptResult => ({ state: { ...st, cursor: c } })
	switch (`${mod}-${k.key}`) {
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
