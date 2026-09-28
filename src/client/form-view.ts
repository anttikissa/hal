// Open questions as the frame shows them: the question, its fields
// and the cursor among them. Pure.

import type { FormState } from '../common/forms.ts'
import { colors, type Style } from '../common/colors.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'
import { itemView } from './item-view.ts'
import { promptView } from './prompt-view.ts'

const { INVERSE, UNINVERSE } = ansi

/**
 * Rows of an open question being filled in, at `width` columns, and
 * where the cursor goes in them: in the focused text, or on the
 * selected option.
 */
function formLines(st: FormState, width: number): { rows: string[]; cursor: { row: number; col: number } } {
	let rows = [...ansi.wrap(`? ${st.form.text}`, width), ...itemView.quoteLines(st.form.quote, width)]
	let f = formView.fieldLines(st, width)
	let hint = st.form.fields.length > 1 ? 'Enter: next · Tab: move · Escape: pause' : 'Enter: answer · Escape: pause'
	let cursor = { row: rows.length + f.cursor.row, col: f.cursor.col }
	return { rows: [...rows, ...f.rows, ansi.quiet(strings.clipVisual(`  ${hint}`, width), colors.warning())], cursor }
}

// Rows of a form's fields alone, and the cursor in them.
function fieldLines(st: FormState, width: number, style: Style = colors.warning()): { rows: string[]; cursor: { row: number; col: number } } {
	let rows: string[] = []
	let cursor = { row: 0, col: 0 }
	st.form.fields.forEach((field, i) => {
		let head = `  ${field.label ? `${ansi.clean(field.label)}: ` : ''}`
		let value = st.values[i]!
		let focused = i === st.focus
		if (field.type === 'choice') {
			let col = strings.visLen(head)
			let parts = field.options.map((o) => {
				let label = ` ${ansi.clean(o)} `
				if (o === value && focused) cursor = { row: rows.length, col: col + 1 }
				col += strings.visLen(label) + 1
				return o === value ? INVERSE + label + UNINVERSE : label
			})
			rows.push(strings.clipVisual(head + parts.join(' '), width))
			return
		}
		// A secret shows one dot per character typed, never the text.
		let dots = (s: string) => '•'.repeat([...new Intl.Segmenter().segment(s)].length)
		let shown = field.type === 'secret' ? dots(value) : value
		let at = field.type === 'secret' ? dots(value.slice(0, st.cursor)).length : st.cursor
		let indent = Math.min(strings.visLen(head), Math.max(0, width - 1))
		let p = promptView.layoutPrompt(shown, at, Math.max(1, width - indent))
		if (!value && field.type === 'text' && field.placeholder) p.rows[0] = ansi.quiet(strings.clipVisual(ansi.clean(field.placeholder), width - indent), style)
		if (focused) cursor = { row: rows.length + p.row, col: indent + p.col }
		p.rows.forEach((r, j) => rows.push((j ? ' '.repeat(indent) : strings.clipVisual(head, indent)) + r))
	})
	return { rows, cursor }
}

export const formView = { formLines, fieldLines }
