// The "Expand or collapse blocks" dialog (Ctrl-O, task v8y), shared by
// terminal and browser: one field running /toggle, a live hint saying
// what Enter does, and a help area that Tab completion's block ids
// replace. Pure; each client draws it and supplies its blocks' states.

import { completion } from './completion.ts'
import { forms } from './forms.ts'
import { modals, type ModalState } from './modals.ts'
import { titles } from './titles.ts'
import { toggle } from './toggle.ts'
import type { Verbosity } from './card.ts'
import type { Item } from './transcript.ts'

// The help area: one key and description pair per row,
// then a note and the kinds (each word's first letter is its kind letter).
// The examples use the session's latest tool block ids when it has two.
function help(items: Item[] = []): [string, string][] {
	let tools = toggle.addressed(items).filter((i) => i.type === 'tool' && toggle.toggles(i)).map((i) => i.key)
	let [a, b, c] = tools.length > 1 ? [tools.at(-3) ?? tools.at(-2)!, tools.at(-2)!, tools.at(-1)!] : ['10', '14', '24']
	return [
		[`t${c}, ${c}`, 'one card'],
		[`${a}-${c}`, 'a range'],
		[`t${b}, t${c}`, 'a list'],
		['t, r', 'all of a kind'],
		['*', 'all cards'],
		['empty', 'latest tool card'],
		['p', "expand paste markers in the prompt you're writing"],
	]
}
const note = 'User and assistant cards toggle only when you ask for it explicitly (a, u).'
const kinds = ['tool', 'reasoning', 'assistant', 'user', 'message', 'system', 'question']

function open(): ModalState {
	let m = modals.open({ title: 'Expand or collapse cards', hint: 'enter: toggle · tab: complete · esc: close', form: { text: 'Expand or collapse cards', fields: [{ type: 'text', name: 'target', placeholder: '24, 10-24 or t' }] } })
	return { ...m, compact: true, question: 'Which cards to expand or collapse?', blocks: { hint: '', help: help() } }
}

// `m` with its hint for the field's text; Tab's list goes.
function update(m: ModalState, items: Item[], fold: (item: Item) => Verbosity): ModalState {
	if (m.form!.values[0]!.trim() === 'p') return { ...m, blocks: { hint: 'No paste markers in the prompt you are writing', invalid: true, help: help(items) } }
	let p = toggle.plan('toggle', items, m.form!.values[0]!, fold)
	let hint = typeof p === 'string' ? { hint: p, invalid: true as const } : { hint: toggle.describe(p, fold) }
	if (typeof p !== 'string' && !m.form!.values[0]!.trim()) hint.hint = `${hint.hint.replace('tool card', 'latest tool card')} (the default)`
	return { ...m, blocks: { ...hint, help: help(items) } }
}

// Tab: the item under the cursor gets the common prefix of the block
// ids it matches; several are listed, newest first. Never cycles.
function complete(m: ModalState, items: Item[], fold: (item: Item) => Verbosity, cursor = m.form!.cursor): ModalState {
	if (m.form!.values[0]!.trim() === 'p') return m
	let text = m.form!.values[0]!
	let before = text.slice(0, cursor)
	let token = /[^,\s-]*$/.exec(before)![0]
	let ref = toggle.reference(token)
	let end = before[before.length - token.length - 1] === '-'
	let found = toggle.addressed(items).filter((i) => toggle.toggles(i) && i.key.startsWith(ref.key) && (!ref.kinds || ref.kinds.includes(titles.letter(i)))).reverse()
	if (!found.length) return { ...m, blocks: { hint: `no card matches ${token || 'here'}`, invalid: true, help: m.blocks!.help } }
	let fill = found.length === 1 ? (end ? found[0]!.key : ref.hash + titles.blockId(found[0]!)) : ref.hash + (end ? '' : ref.kinds) + completion.common(found.map((i) => i.key))
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
