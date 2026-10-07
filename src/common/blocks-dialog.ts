// The "Expand or collapse blocks" dialog (Ctrl-O, task v8y), shared by
// terminal and browser: one field running /toggle, a live hint saying
// what Enter does, and a help area that Tab completion's block ids
// replace. Pure; each client draws it and supplies its blocks' states.

import { completion } from './completion.ts'
import { forms } from './forms.ts'
import { modals, type ModalState } from './modals.ts'
import { titles } from './titles.ts'
import { toggle, type Fold } from './toggle.ts'
import { rebaseCards } from './rebase-cards.ts'
import type { Item } from './transcript.ts'

// The help area: key and description pairs, row by row in two columns,
// then a note and the kinds (each word's first letter is its kind letter).
const help: [string, string][] = [
	['24, #t24', 'one block'], ['t*', 'all tool blocks'],
	['10-24', 'a range'], ['r*', 'all thinking (reasoning) blocks'],
	['t14, r2-9', 'a list'], ['Tab', 'complete a block id'],
	['empty', 'latest tool block'],
]
const note = 'User and assistant blocks change only when you name them (a, u).'
const kinds = ['tool', 'reasoning', 'assistant', 'user', 'message', 'system', 'question']

function open(): ModalState {
	let m = modals.open({ title: 'Expand or collapse blocks', hint: 'enter: run · esc: close', form: { text: 'Expand or collapse blocks', fields: [{ type: 'text', name: 'target', placeholder: '24, 10-24 or t*' }] } })
	return { ...m, compact: true, blocks: { hint: '' } }
}

// `m` with its hint for the field's text; Tab's list goes.
function update(m: ModalState, items: Item[], fold: (item: Item) => Fold): ModalState {
	let p = toggle.plan('toggle', items, m.form!.values[0]!, fold)
	let hint = typeof p === 'string' ? { hint: p, invalid: true as const } : { hint: toggle.describe(p, (i) => toggle.next(i, fold(i))) }
	return { ...m, blocks: hint }
}

// Tab: the item under the cursor gets the common prefix of the block
// ids it matches; several are listed, newest first. Never cycles.
function complete(m: ModalState, items: Item[], fold: (item: Item) => Fold, cursor = m.form!.cursor): ModalState {
	items = rebaseCards.group(items)
	let text = m.form!.values[0]!
	let before = text.slice(0, cursor)
	let token = /#?[a-z]*\d*$/i.exec(before)![0]
	let parts = /^(#?)([a-z]*)(\d*)$/i.exec(token)!
	let end = before[before.length - token.length - 1] === '-'
	let letters = parts[2]!.toLowerCase()
	let found = items.filter((i) => /^\d+$/.test(i.key) && toggle.toggles(i) && i.key.startsWith(parts[3]!) && (!letters || letters.includes(titles.letter(i)))).reverse()
	if (!found.length) return { ...m, blocks: { hint: `no block matches ${token || 'here'}`, invalid: true } }
	let fill = found.length === 1 ? (end ? found[0]!.key : parts[1]! + titles.blockId(found[0]!)) : parts[1]! + (end ? '' : parts[2]!) + completion.common(found.map((i) => i.key))
	let value = before.slice(0, before.length - token.length) + fill + text.slice(cursor)
	let form = { ...forms.set(m.form!, 0, value), cursor: cursor - token.length + fill.length }
	let next = blocksDialog.update({ ...m, form }, items, fold)
	return found.length > 1 ? { ...next, blocks: { ...next.blocks!, choices: found.map((i) => titles.blockId(i)) } } : next
}

// `ids` packed in rows of cells `width` wide at most, `rows` rows at
// most, the last cell '+N more' when they do not all fit.
function pack(ids: string[], width: number, rows: number): string[] {
	let cell = Math.max(...ids.map((s) => s.length), `+${ids.length} more`.length) + 2
	let per = Math.max(1, Math.floor((width + 2) / cell))
	let room = per * rows
	let cells = ids.length > room ? [...ids.slice(0, room - 1), `+${ids.length - room + 1} more`] : ids
	let out: string[] = []
	for (let i = 0; i < cells.length; i += per) out.push(cells.slice(i, i + per).map((c, k, row) => (k < row.length - 1 ? c.padEnd(cell) : c)).join(''))
	return out
}

export const blocksDialog = { help, note, kinds, open, update, complete, pack }
