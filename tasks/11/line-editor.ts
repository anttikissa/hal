// Small reusable single-line editor.
// Used by popup inputs. Keeps the useful prompt keybindings without multiline
// and history complexity.

import type { KeyEvent } from './keys.ts'

interface LineEditorState {
	text: string
	cursor: number
	selAnchor: number | null
}

interface BuiltLine {
	line: string
	cursor: number
}

function create(initial = '') {
	const state: LineEditorState = {
		text: initial,
		cursor: initial.length,
		selAnchor: null,
	}

	function clamp(pos: number): number {
		return Math.max(0, Math.min(pos, state.text.length))
	}

	function selection(): { start: number; end: number } | null {
		if (state.selAnchor === null) return null
		const start = Math.min(state.selAnchor, state.cursor)
		const end = Math.max(state.selAnchor, state.cursor)
		return start === end ? null : { start, end }
	}

	function move(pos: number, selecting: boolean): void {
		if (selecting) {
			if (state.selAnchor === null) state.selAnchor = state.cursor
		} else {
			state.selAnchor = null
		}
		state.cursor = clamp(pos)
	}

	function replaceSelection(next: string): void {
		const sel = selection()
		if (sel) {
			state.text = state.text.slice(0, sel.start) + next + state.text.slice(sel.end)
			state.cursor = sel.start + next.length
		} else {
			state.text = state.text.slice(0, state.cursor) + next + state.text.slice(state.cursor)
			state.cursor += next.length
		}
		state.selAnchor = null
	}

	function deleteSelection(): boolean {
		const sel = selection()
		if (!sel) return false
		state.text = state.text.slice(0, sel.start) + state.text.slice(sel.end)
		state.cursor = sel.start
		state.selAnchor = null
		return true
	}

	function buildLine(): BuiltLine {
		const sel = selection()
		if (!sel) return { line: state.text, cursor: state.cursor }
		return {
			line:
				state.text.slice(0, sel.start) +
				'\x1b[7m' +
				state.text.slice(sel.start, sel.end) +
				'\x1b[0m' +
				state.text.slice(sel.end),
			cursor: state.cursor,
		}
	}

	function handleKey(k: KeyEvent): boolean {
		if (k.cmd) {
			if (k.key === 'a') {
				state.selAnchor = 0
				state.cursor = state.text.length
				return true
			}
			return false
		}

		if (k.key === 'a' && k.ctrl) {
			move(0, k.shift)
			return true
		}
		if (k.key === 'e' && k.ctrl) {
			move(state.text.length, k.shift)
			return true
		}
		if (k.key === 'home') {
			move(0, k.shift)
			return true
		}
		if (k.key === 'end') {
			move(state.text.length, k.shift)
			return true
		}
		if (k.key === 'left') {
			move(state.cursor - 1, k.shift)
			return true
		}
		if (k.key === 'right') {
			move(state.cursor + 1, k.shift)
			return true
		}
		if (k.key === 'backspace') {
			if (!deleteSelection() && state.cursor > 0) {
				state.text = state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor)
				state.cursor--
			}
			return true
		}
		if (k.key === 'delete') {
			if (!deleteSelection() && state.cursor < state.text.length) {
				state.text = state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1)
			}
			return true
		}
		if (k.char && !k.ctrl && !k.alt && !k.cmd && !k.char.includes('\n')) {
			replaceSelection(k.char)
			return true
		}
		return false
	}

	function setText(text: string, cursor = text.length): void {
		state.text = text
		state.cursor = clamp(cursor)
		state.selAnchor = null
	}

	function clear(): void {
		setText('')
	}

	function text(): string {
		return state.text
	}

	function cursorPos(): number {
		return state.cursor
	}

	return { handleKey, buildLine, setText, clear, text, cursorPos }
}

export const lineEditor = { create }
