// Modals as the frame shows them: a box of fields and a scrolling list,
// drawn over the transcript in the middle of the screen. Pure.

import { colors, type Style } from '../common/colors.ts'
import { fuzzy } from '../common/fuzzy.ts'
import { modals, type ModalState } from '../common/modals.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'
import { formView } from './form-view.ts'
import { findDialog } from '../common/find-dialog.ts'

const { UNCOLOR, RESET, LINK_OFF } = ansi

type Cursor = { row: number; col: number }

/**
 * Where a modal goes on a terminal of `rows` × `cols`: a fixed height
 * (80% of the rows, at most 36) and width, centred across. Outside it
 * on each side: at least one blank column and one of transcript.
 */
function modalBox(rows: number, cols: number): { height: number; width: number; left: number } {
	let height = Math.min(rows, Math.max(3, Math.min(36, Math.floor(rows * 0.8))))
	let width = cols < 10 ? cols : Math.min(100, cols - 2 * Math.max(2, Math.round(cols * 0.1)))
	return { height, width, left: Math.floor((cols - width) / 2) }
}

// A border row: `fill` between the corners, with `text` after its first
// two columns and `right` before its last two.
function border(l: string, r: string, text: string, right: string, width: number): string {
	let inner = width - 2
	right = right && right.length + 2 <= inner - 2 ? ` ${right} ` : ''
	text = strings.clipVisual(text ? ` ${ansi.clean(text)} ` : '', Math.max(0, inner - 2 - strings.visLen(right)))
	let fill = Math.max(0, inner - 2 - strings.visLen(text) - strings.visLen(right))
	return l + (inner > 0 ? '─' : '') + text + '─'.repeat(fill) + right + (inner > 1 ? '─' : '') + r
}

/**
 * All rows of a modal box `width` × `height`, outline included, and
 * where the cursor goes in them: in the focused field, else on the
 * selected item. The fields stay at the top; the list scrolls below
 * them, from `scroll` as little as it must to show the selection.
 */
function modalLines(m: ModalState, width: number, height: number): { rows: string[]; cursor: Cursor; scroll: number } {
	let inner = Math.max(0, width - 4)
	let fields = m.form ? formView.fieldLines(m.form, inner, { fg: colors.popup().neutralFg! }) : { rows: [], cursor: undefined }
	let content = fields.rows.slice(0, height - 2)
	if (m.find) {
		if (m.find.focus !== 0) fields.cursor = undefined
		content.push(strings.clipVisual(findDialog.labels.map((label, i) => `${m.find!.focus === i + 1 ? '›' : ''}[${m.find!.filters.includes(findDialog.filters[i]!) ? 'x' : ' '}] ${label}`).join('  '), inner))
	}
	let current = colors.popupCurrent(colors.popup().neutralFg!)
	let below = modalView.footer(m, inner)
	let visible = Math.max(0, height - 2 - content.length - below.length)
	let scroll = modalView.modalScroll(m, visible)
	let cursor = fields.cursor ?? { row: m.find && m.find.focus > 0 && m.find.focus < 5 ? content.length - 1 : content.length, col: 0 }
	// Settings-like rows: the items as a column as wide as the longest.
	let column = m.values ? Math.min(Math.floor(inner / 2), Math.max(0, ...m.items.map((s) => strings.visLen(s)))) + 2 : 0
	for (let i = scroll; i < Math.min(m.items.length, scroll + visible); i++) {
		// Leading spaces are the picker's tree indentation: keep them.
		let label = ansi.clean(m.items[i]!).replace(/[\r\n\t]+/g, ' ')
		if (column) label = strings.clipVisual(label, column - 2).padEnd(column - 2) + '  '
		let row = strings.clipVisual((i === m.selected ? `${formView.ARROW} ` : '  ') + label, inner)
		if (m.query) row = modalView.highlight(row, m.query, i === m.selected ? current : undefined, !!m.find)
		let value = modalView.cell(m, i, current)
		if (value) row += strings.clipVisual(value.text, Math.max(0, inner - 2 - column))
		if (value?.cursor !== undefined) cursor = { row: content.length, col: Math.min(inner - 1, 2 + column + value.cursor) }
		if (i === m.selected) {
			if (!fields.cursor && !m.edit && (!m.find || m.find.focus === 5)) cursor = { row: content.length, col: 0 }
			// Monochrome: reverse video instead of the highlight colour.
			row = (ansi.sgr(current) || ansi.INVERSE) + row + ' '.repeat(inner - strings.visLen(row)) + UNCOLOR + ansi.UNINVERSE
		}
		content.push(row)
	}
	// The footer sits at the bottom, below the list's empty rows.
	while (content.length < height - 2 - below.length) content.push('')
	content.push(...below)
	let line = ansi.sgr({ fg: colors.popup().neutralFg! })
	let side = (s: string) => (width >= 2 ? line + s + UNCOLOR : '')
	let pad = (s: string) => {
		if (width < 4) return ' '.repeat(Math.max(0, width - 2))
		let fit = strings.clipVisual(s, inner)
		return ' ' + fit + RESET + ' '.repeat(inner - strings.visLen(fit)) + ' '
	}
	let after = m.items.length - scroll - visible
	let place = scroll > 0 || after > 0 ? `${m.selected + 1}/${m.items.length}` : ''
	let rows = [line + modalView.border('┌', '┐', m.title, '', width) + UNCOLOR]
	for (let r = 0; r < height - 2; r++) rows.push(side('│') + pad(content[r] ?? '') + side('│'))
	rows.push(line + modalView.border('└', '┘', m.hint ?? '', place, width) + UNCOLOR)
	// A box too small for its fields still keeps the cursor inside it.
	let at = { row: Math.min(height - 1, 1 + cursor.row), col: Math.max(0, Math.min(width - 1, 2 + cursor.col)) }
	return { rows: rows.slice(0, height), cursor: at, scroll }
}

// Row `i`'s value column (modals.ts `values`), if the modal has one: the
// value, or the edit field with where its cursor is; on the selected
// row then the faint note, back to `current` (the selection's colour).
function cell(m: ModalState, i: number, current: Style): { text: string; cursor?: number } | undefined {
	if (!m.values) return undefined
	if (m.edit?.index === i) {
		let f = m.edit.form
		let text = f.form.fields[0]?.type === 'secret' ? '•'.repeat(f.values[0]!.length) : f.values[0]!
		return { text, cursor: strings.visLen(text.slice(0, f.cursor)) }
	}
	let value = ansi.clean(m.values[i] ?? '')
	let note = i === m.selected && m.notes?.[i] ? ansi.clean(m.notes[i]!) : ''
	if (!note) return { text: value }
	let faint = ansi.mono() ? '' : ansi.sgr({ fg: colors.popupNote().fg! })
	let back = ansi.mono() ? '' : current.fg ? ansi.sgr({ fg: current.fg }) : '\x1b[39m'
	return { text: `${value}   ${faint}${note}${back}` }
}

// The rows below the list: the selected item's details, wrapped, and why
// a change was refused.
function footer(m: ModalState, width: number): string[] {
	let detail = m.details?.[m.selected]
	let rows: string[] = []
	if (detail) rows.push('', ...strings.wordWrap(ansi.clean(detail), width))
	if (m.error) rows.push(ansi.sgr({ fg: colors.error().fg! }) + strings.clipVisual(ansi.clean(m.error), width) + UNCOLOR)
	return rows
}

// `row` (plain text) with the query's matches bold and bright, then back
// to `after`'s colour (the selected row's) or the default. Monochrome:
// bold only.
function highlight(row: string, query: string, after?: Style, literal = false): string {
	let on = ansi.BOLD + (ansi.mono() ? '' : ansi.sgr({ fg: colors.popupMatch().fg! }))
	let off = ansi.UNBOLD + (ansi.mono() ? '' : after?.fg ? ansi.sgr({ fg: after.fg }) : '\x1b[39m')
	let out = ''
	let at = 0
	for (let [from, to] of literal ? findDialog.marks(row, query) : fuzzy.marks(row, query)) {
		out += row.slice(at, from) + on + row.slice(from, to) + off
		at = to
	}
	return out + row.slice(at)
}

// The first list row a modal shows with `visible` rows for its list.
function modalScroll(m: ModalState, visible: number): number {
	return modals.scroll(m.scroll, m.selected, m.items.length, visible)
}

// `line` with the box row `row` drawn over its columns from `left`, a
// blank column kept on each side of the box.
function overlay(line: string, row: string, left: number, width: number, cols: number): string {
	let before = left > 0 ? strings.sliceVisual(line, 0, left - 1) : ''
	if (before.includes('\x1b]8;')) before += LINK_OFF
	let gap = left > 0 ? ' '.repeat(left - strings.visLen(before)) : ''
	let right = left + width + 1
	let after = right < cols ? strings.sliceVisual(line, right, cols) : ''
	return before + RESET + gap + row + RESET + (left + width < cols ? ' ' : '') + after
}

// Draws modal `m` over `lines`, centred on the screen (the last `rows`
// of them), so that it never reaches into scrollback. A short frame
// grows to hold it. Returns the cursor and the list's scroll.
function withModal(lines: string[], m: ModalState, rows: number, cols: number): { cursor: Cursor; scroll: number } {
	let box = modalView.modalBox(rows, cols)
	while (lines.length < box.height) lines.push('')
	let screen = Math.min(lines.length, rows)
	let top = lines.length - screen + Math.floor((screen - box.height) / 2)
	let drawn = modalView.modalLines(m, box.width, box.height)
	drawn.rows.forEach((r, i) => (lines[top + i] = modalView.overlay(lines[top + i]!, r, box.left, box.width, cols)))
	return { cursor: { row: top + drawn.cursor.row, col: box.left + drawn.cursor.col }, scroll: drawn.scroll }
}

export const modalView = { modalBox, border, modalLines, cell, footer, highlight, modalScroll, overlay, withModal }
