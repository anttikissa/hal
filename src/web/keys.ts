/// <reference lib="dom" />
// Keys pressed on the page, decided without the DOM: Chat.tsx describes
// where each landed (a Target) and prevents the browser's default when
// key() says it handled it.
//
// Enter submits (steering a running turn; Alt+Enter queues after it,
// Shift+Enter is a newline; on a touch keyboard Enter is a newline),
// Escape pauses a running turn, Up on an empty box edits the last
// prompt (src/common/amend.ts), Up on the box's first line and Down on
// its last browse the prompts sent (src/common/recall.ts; a line ends
// only at a newline here, as the page cannot know where the textarea
// wraps), Tab completes a slash command, command keys (Ctrl-M, F1) run theirs,
// the readline keys in editor.table edit the box. A printable key
// pressed outside any field types into the box.

import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Key } from '../common/forms.ts'
import { prompt } from '../common/prompt.ts'
import { recall } from '../common/recall.ts'
import { app } from './app.ts'
import { attach, type Pasted } from './attach.ts'
import { editor, type Splice } from './editor.ts'
import { tabs } from './tabs.ts'
import { view } from './view.ts'
import { commandList } from '../common/commands/list.ts'
import { find } from './find.ts'

// Where a key was pressed: the message box (its text, the caret, and
// `write`, which edits the box natively and leaves the selection from
// `anchor` to `cursor`; `anchor`: the selection's other end), a text field of the open
// question, a button or link (`submits`: a form's submit button), or
// anywhere else. `coarse`: the box is typed on a touch keyboard
// (pointer: coarse), which has no Shift: Enter is a newline there and
// the Send button sends.
export type Target =
	| { kind: 'message'; text: string; cursor: number; anchor?: number; write?: (edit: Splice, cursor: number, anchor: number) => void; coarse?: boolean }
	| { kind: 'field' }
	| { kind: 'link' }
	| { kind: 'button'; submits: boolean }
	| { kind: 'other' }

// `code`: the physical key (KeyD), for Option-letters on macOS.
export type KeyInput = { key: string; code?: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean }

// A key that types a character: one code point, no Ctrl, Alt or Cmd.
function typing(e: KeyInput): boolean {
	return [...e.key].length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey
}

const arrows: Record<string, 'up' | 'down' | 'escape'> = { ArrowUp: 'up', ArrowDown: 'down', Escape: 'escape' }

// A key pressed on the page. True if handled here (the caller then
// prevents the browser's default).
function key(e: KeyInput, target: Target): boolean {
	let st = app.state
	if (e.isComposing) return false
	if (tabs.key(e)) return true
	// The message box may hold text no input event told us about.
	if (target.kind === 'message' && target.text !== st.text) app.input(target.text)
	let k = view.key(e)
	if (k && commandList.byKey({ key: k.key.toLowerCase(), ctrl: !!k.ctrl, cmd: !!k.cmd, alt: !!k.alt, shift: !!k.shift })?.name === 'find') { find.open(); return true }
	// Find has native text editing; model arrows remain tree/effort keys.
	if (st.view.modal) {
		if (st.view.modal.find) {
			if (!k || e.ctrlKey || e.metaKey || e.altKey || !['enter', 'escape', 'up', 'down'].includes(k.key)) return false
			find.key(k)
			return true
		}
		if ((target.kind === 'button' || target.kind === 'link') && (e.key === 'Enter' || e.key === ' ')) return false
		if (!k || e.ctrlKey || e.metaKey || e.altKey || !['left', 'right', 'enter', 'escape', 'up', 'down'].includes(k.key)) return false
		app.modalKey(k)
		return true
	}
	let command = k && view.commandKey(st.view, k, tabs.mac())
	if (command) {
		connection.send(command)
		return true
	}
	if (st.view.form) {
		// Native Tab reaches every control and URL; Enter on a URL never answers.
		if (e.key === 'Tab' || (target.kind === 'link' && e.key === 'Enter')) return false
		// Text fields edit natively, a submit button submits, Cmd and Ctrl
		// keys stay the browser's (Cmd-R, Cmd-L); the shared form keys
		// decide the rest.
		let native = target.kind === 'field' && !['enter', 'escape', 'tab', 'up', 'down'].includes(k?.key ?? '')
		if (!k || native || e.metaKey || e.ctrlKey || (target.kind === 'button' && target.submits && e.key === 'Enter')) return false
		let { state, command } = view.formKey(st.view, k)
		app.setView(state)
		if (command) app.sendNow(command)
		return true
	}
	let plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
	if (plain && e.key === 'Escape' && st.menu) return app.menuKey('escape')
	if (plain && target.kind === 'message' && st.menu && !(e.key === 'Enter' && target.coarse)) {
		let menuKey = { ArrowUp: 'up', ArrowDown: 'down', Escape: 'escape', Enter: 'enter' } as const
		let choice = menuKey[e.key as keyof typeof menuKey]
		if (choice && app.menuKey(choice)) return true
	}
	let edit = plain && target.kind === 'message' && arrows[e.key] ? view.editKey(st.view, arrows[e.key]!, st.text) : undefined
	if (edit) {
		st.view = edit.view
		if (edit.command) connection.send(edit.command)
		app.input(edit.text)
		return true
	}
	if (e.key === 'Escape') {
		let command = view.pause(st.view)
		if (command) connection.send(command)
		return false
	}
	if (target.kind !== 'message') {
		// Typing outside any field goes into the box at its caret, as in
		// Slack; Space still presses a focused button or link.
		if (target.kind === 'field' || !typing(e) || (target.kind === 'button' && e.key === ' ')) return false
		keys.insert(e.key)
		return true
	}
	let sel = target.anchor === undefined ? '' : st.text.slice(Math.min(target.anchor, target.cursor), Math.max(target.anchor, target.cursor))
	if (plain && !sel && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && keys.recall(e.key === 'ArrowUp' ? -1 : 1, target)) return true
	if (k && editor.routed(k)) return keys.edit(k, target)
	if (e.key === 'Tab' && !e.shiftKey && target.cursor === st.text.length && st.menu) {
		app.choose(st.menu.selected)
		return true
	}
	let complete = e.key === 'Tab' && !e.shiftKey && target.cursor === st.text.length && view.complete(st.view, st.text)
	if (complete) {
		st.completedByTab = st.text
		connection.send(complete)
		return true
	}
	// Tab and Shift-Tab indent a selection across lines; else they move
	// focus, keeping the page keyboard-accessible.
	if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && sel.includes('\n')) return keys.edit({ key: 'tab', shift: e.shiftKey }, target)
	if (e.key !== 'Enter' || e.shiftKey || (target.coarse && plain)) return false
	app.send(e.altKey)
	return true
}

// A key from editor.table on the message box: the shared editor's step
// on its text and caret, written back as a native edit.
function edit(k: Key, target: Extract<Target, { kind: 'message' }>): boolean {
	let st = app.state
	let at = { text: st.text, cursor: target.cursor, kill: st.kill }
	let { state } = prompt.step(target.anchor === undefined ? at : { ...at, anchor: target.anchor }, k)
	st.kill = state.kill
	// A move writes an empty edit: only the caret and selection change.
	target.write?.(editor.splice(st.text, state.text), state.cursor, state.anchor ?? state.cursor)
	app.input(state.text)
	return true
}

// Input history for Up (-1) or Down (1) on the box, through the shared
// code with logical lines for rows. True if handled; else the key stays
// native.
function recallKey(dir: -1 | 1, target: Extract<Target, { kind: 'message' }>): boolean {
	let st = app.state
	let t = st.view.transcript
	if (!t) return false
	let id = t.meta.id
	let shown = recall.step(id, recall.entries(t), st.text, target.cursor, dir, Infinity, drafts.text(id))
	if (!shown) return false
	target.write?.(editor.splice(st.text, shown.text), shown.cursor, shown.cursor)
	app.input(shown.text)
	return true
}


// A paste on the page outside any field goes into the box at its caret
// (an image or long text as an attachment, attach.ts). True if taken
// here, so the caller stops the browser's own paste.
function paste(data: Pasted, target: Target): boolean {
	if (target.kind === 'message' || target.kind === 'field' || app.state.view.modal || app.state.view.form) return false
	if (!attach.paste(data, keys.insert)) keys.insert(data.getData('text/plain'))
	return true
}

// Files dropped anywhere on the page go into the box at its caret
// (attach.files), unless a question or the picker owns the keys.
function drop(list: ArrayLike<File>): void {
	if (app.state.view.modal || app.state.view.form) return
	attach.files(list, keys.insert)
}

export const keys = {
	key,
	paste,
	drop,
	edit,
	recall: recallKey,
	// Types text into the message box at its caret, focusing it
	// (Composer.tsx points it at the textarea).
	insert: (_text: string): void => {},
}
