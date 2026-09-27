// Undo and redo for the prompt editor (prompt.ts): two stacks of
// snapshots (text, cursor, selection anchor) kept in the editor state,
// so each session's prompt has its own and sending clears them. At most
// `LIMIT` steps are kept.

import type { PromptState, PromptSnapshot } from './prompt.ts'

function snapshot(st: PromptState): PromptSnapshot {
	return st.anchor === undefined ? { text: st.text, cursor: st.cursor } : { text: st.text, cursor: st.cursor, anchor: st.anchor }
}

// `st`, an edit of `before`: one more step to undo, none to redo.
function record(st: PromptState, before: PromptState): PromptState {
	let { redo: _, ...rest } = st
	return { ...rest, undo: [...(before.undo ?? []), promptUndo.snapshot(before)].slice(-promptUndo.LIMIT) }
}

// Undo (or redo) one step; with none left the state stays as it is.
function undo(st: PromptState, redo = false): PromptState {
	let { goal: _g, typed: _t, anchor: _a, undo: back = [], redo: forth = [], ...rest } = st
	let [from, to] = redo ? [forth, back] : [back, forth]
	let last = from.at(-1)
	if (!last) return st
	from = from.slice(0, -1)
	to = [...to, promptUndo.snapshot(st)]
	let [undoList, redoList] = redo ? [to, from] : [from, to]
	return { ...rest, ...last, undo: undoList, redo: redoList }
}

export const promptUndo = { LIMIT: 200, snapshot, record, undo }
