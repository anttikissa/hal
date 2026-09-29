// Modals as the frame shows them: a box of fields and a scrolling list,
// drawn over the transcript in the middle of the screen. Pure.

import { colors } from '../common/colors.ts'
import { modals, type ModalState } from '../common/modals.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'
import { formView } from './form-view.ts'

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
	let visible = Math.max(0, height - 2 - content.length)
	let scroll = modalView.modalScroll(m, visible)
	let current = colors.popupCurrent()
	let cursor = fields.cursor ?? { row: content.length, col: 0 }
	for (let i = scroll; i < Math.min(m.items.length, scroll + visible); i++) {
		// Leading spaces are the picker's tree indentation: keep them.
		let row = strings.clipVisual((i === m.selected ? '> ' : '  ') + ansi.clean(m.items[i]!).replace(/[\r\n\t]+/g, ' '), inner)
		if (i === m.selected) {
			if (!fields.cursor) cursor = { row: content.length, col: 0 }
			// Monochrome: reverse video instead of the highlight colour.
			row = (ansi.sgr(current) || ansi.INVERSE) + row + ' '.repeat(inner - strings.visLen(row)) + UNCOLOR + ansi.UNINVERSE
		}
		content.push(row)
	}
	let line = ansi.sgr({ fg: colors.popup().neutralFg! })
	let side = (s: string) => (width >= 2 ? line + s + UNCOLOR : '')
	let pad = (s: string) => {
		if (width < 4) return ' '.repeat(Math.max(0, width - 2))
		let fit = strings.clipVisual(s, inner)
		return ' ' + fit + RESET + ' '.repeat(inner - strings.visLen(fit)) + ' '
	}
	let below = m.items.length - scroll - visible
	let place = scroll > 0 || below > 0 ? `${m.selected + 1}/${m.items.length}` : ''
	let rows = [line + modalView.border('╭', '╮', m.title, '', width) + UNCOLOR]
	for (let r = 0; r < height - 2; r++) rows.push(side('│') + pad(content[r] ?? '') + side('│'))
	rows.push(line + modalView.border('╰', '╯', m.hint ?? '', place, width) + UNCOLOR)
	// A box too small for its fields still keeps the cursor inside it.
	let at = { row: Math.min(height - 1, 1 + cursor.row), col: Math.max(0, Math.min(width - 1, 2 + cursor.col)) }
	return { rows: rows.slice(0, height), cursor: at, scroll }
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

export const modalView = { modalBox, border, modalLines, modalScroll, overlay, withModal }
