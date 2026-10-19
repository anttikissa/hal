// Open questions as the frame shows them: the question, its fields
// and the cursor among them. Pure.

import { forms, type FormState } from '../common/forms.ts'
import { colors, type Style } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
import { strings } from '../common/strings.ts'
import { titles } from '../common/titles.ts'
import { ansi } from './ansi.ts'
import { itemView } from './item-view.ts'
import { promptView } from './prompt-view.ts'

/**
 * Rows of an open question being filled in, at `width` columns, headed
 * by its time `ts` and text like every block, and
 * where the cursor goes in them: in the focused text, or on the
 * selected option.
 */
function formLines(
	st: FormState,
	width: number,
	ts?: string,
): { rows: string[]; cursor: { row: number; col: number } } {
	let quote = itemView.quoteLines(st.form.quote, width)
	let rows = [...ansi.wrap(titles.stamp(ts, st.form.text), width), ...(quote.length ? ['', ...quote] : [])]
	let f = formView.fieldLines(st, width)
	let escape = st.form.skip ? 'Escape: skip' : 'Escape: pause'
	let hint = st.form.fields.length > 1 ? `Enter: next · Tab: move · ${escape}` : `Enter: answer · ${escape}`
	// The fields stand apart: a blank row above and below them.
	let cursor = { row: rows.length + 1 + f.cursor.row, col: f.cursor.col }
	return { rows: [...rows, '', ...f.rows, '', ansi.quiet(strings.clipVisual(hint, width), colors.question())], cursor }
}

// Rows of a form's fields alone, and the cursor in them, at `now`
// (Date.now(): where rotating placeholders are).
function fieldLines(
	st: FormState,
	width: number,
	style: Style = colors.question(),
	now = Date.now(),
): { rows: string[]; cursor: { row: number; col: number } } {
	let rows: string[] = []
	let cursor = { row: 0, col: 0 }
	st.form.fields.forEach((field, i) => {
		if (field.help) rows.push(...ansi.wrap(`  ${ansi.clean(field.help)}`, width))
		let head = `  ${field.label ? `${ansi.clean(field.label)}: ` : ''}`
		let value = st.values[i]!
		let focused = i === st.focus
		let lit = colors.popupCurrent(style.fg ?? colors.popup().neutralFg!)
		let mark = (o: string) => {
			let label = `${o === value ? formView.ARROW : ' '} ${ansi.clean(o)} `
			return o === value
				? (ansi.sgr(lit) || ansi.INVERSE) + label + ansi.UNCOLOR + ansi.UNINVERSE + ansi.sgr(style)
				: label
		}
		// An inline choice is one row: its label, then its options, lined
		// up with the other inline rows' options.
		if (field.type === 'choice' && field.inline) {
			let pad = Math.max(
				...st.form.fields.map((f) =>
					f.type === 'choice' && f.inline && f.label ? strings.visLen(ansi.clean(f.label)) + 2 : 0,
				),
			)
			let lead = `  ${(field.label ? `${ansi.clean(field.label)}: ` : '').padEnd(pad)}`
			let at =
				strings.visLen(lead) +
				field.options.slice(0, field.options.indexOf(value)).reduce((n, o) => n + strings.visLen(ansi.clean(o)) + 3, 0)
			if (focused) cursor = { row: rows.length, col: at + 2 }
			rows.push(strings.clipVisual(lead + field.options.map(mark).join(''), width))
			return
		}
		// A choice's options stand in a column under its label.
		if (field.type === 'choice') {
			if (field.label) rows.push(strings.clipVisual(head.trimEnd(), width))
			// The chosen one is marked and lit like a picker's selection.
			let indent = field.label ? '  ' : ''
			for (let o of field.options) {
				if (o === value && focused) cursor = { row: rows.length, col: indent.length + 2 }
				rows.push(strings.clipVisual(indent + mark(o), width))
			}
			return
		}
		// A secret shows one dot per character typed, never the text.
		let dots = (s: string) => '•'.repeat([...new Intl.Segmenter().segment(s)].length)
		let shown = field.type === 'secret' ? dots(value) : value
		let at = field.type === 'secret' ? dots(value.slice(0, st.cursor)).length : st.cursor
		let indent = Math.min(strings.visLen(head), Math.max(0, width - 1))
		let p = promptView.layoutPrompt(shown, at, Math.max(1, width - indent))
		// The example stays well below typed text, like the prompt's
		// (oklch.faint): dimmer than the readable-text minimum on purpose.
		let ex = value ? undefined : forms.example(st, i, now)
		if (ex?.text)
			p.rows[0] =
				ansi.mono() || !style.fg
					? strings.clipVisual(ansi.clean(ex.text), width - indent)
					: promptView.example(
							ex,
							oklch.faint(style.fg, style.bg ?? colors.screen),
							style.bg ?? colors.screen,
							width - indent,
							style.fg,
						)
		if (focused) cursor = { row: rows.length + p.row, col: indent + p.col }
		p.rows.forEach((r, j) => rows.push((j ? ' '.repeat(indent) : strings.clipVisual(head, indent)) + r))
	})
	return { rows, cursor }
}

export const formView = { ARROW: '→', formLines, fieldLines }
