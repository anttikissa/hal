// Editable prompt state: a pure transition from (state, key) to a new
// state plus an optional action for the caller (submit, cancel, quit).
//
// The cursor is a UTF-16 offset into text that always sits on a grapheme
// cluster boundary, so movement and deletion act on whole user-perceived
// characters (combining marks, ZWJ emoji, flags).

import type { KeyEvent } from './keys.ts'

export interface PromptState {
	text: string
	/** UTF-16 offset, always on a grapheme boundary. */
	cursor: number
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

function empty(): PromptState {
	return { text: '', cursor: 0 }
}

function insert(st: PromptState, s: string): PromptState {
	let text = st.text.slice(0, st.cursor) + s + st.text.slice(st.cursor)
	let pos = st.cursor + s.length
	// The insert may merge with its neighbours into one cluster (e.g. a
	// regional indicator pairing into a flag); move to the next boundary.
	let cursor = pos === 0 || prompt.boundaries(text).includes(pos) ? pos : prompt.nextBoundary(text, pos)
	return { text, cursor }
}

function apply(st: PromptState, k: KeyEvent): PromptResult {
	let plain = !k.ctrl && !k.alt && !k.cmd
	switch (k.key) {
		case 'enter':
			if (k.alt && !k.ctrl && !k.cmd && !k.shift) return { state: prompt.empty(), action: { type: 'submit', text: st.text, queue: true } }
			if (!plain) break
			if (k.shift) return { state: prompt.insert(st, '\n') }
			return { state: prompt.empty(), action: { type: 'submit', text: st.text } }
		case 'escape':
			return { state: st, action: { type: 'cancel' } }
		case 'd':
			if (k.ctrl && !k.alt && !k.cmd) return st.text === '' ? { state: st, action: { type: 'quit' } } : { state: st }
			break
		case 'left':
			return { state: { ...st, cursor: prompt.prevBoundary(st.text, st.cursor) } }
		case 'right':
			return { state: { ...st, cursor: prompt.nextBoundary(st.text, st.cursor) } }
		case 'backspace': {
			if (st.cursor === 0) return { state: st }
			let from = prompt.prevBoundary(st.text, st.cursor)
			return { state: { text: st.text.slice(0, from) + st.text.slice(st.cursor), cursor: from } }
		}
		case 'paste':
			return { state: k.text ? prompt.insert(st, k.text) : st }
	}
	if (k.text !== undefined && plain) return { state: prompt.insert(st, k.text) }
	return { state: st }
}

export const prompt = {
	empty,
	apply,
	insert,
	boundaries,
	prevBoundary,
	nextBoundary,
}
