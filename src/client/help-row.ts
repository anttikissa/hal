// The help row, the chrome's last row (task p0): always exactly one
// row, so the prompt never jumps when what it says changes. In
// priority order: the keys of an open question, the hint while editing
// the last prompt, tab completion's choices, else the key hints for
// the session's state (sendKeys.hints, shared with the web; then 'ctrl-r: reload' when a new commit
// is checked out) with '/keys: shortcuts' at the right. Keys in
// the help key color, descriptions in its description color, as in
// the old Hal. Pure.

import { colors } from '../common/colors.ts'
import type { FormState } from '../common/forms.ts'
import { sendKeys } from '../common/send-keys.ts'
import type { SessionState } from '../common/states.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'

export type Hint = [key: string, description: string]

// What the help row needs to know; the frame's View fits.
export type HelpInput = {
	prompt: { text: string }
	form?: FormState
	/** The hint while the last prompt is being edited. */
	editing?: string
	choices?: string[] | Hint[]
	transcript?: { state: SessionState }
	/** A new commit is checked out (task n1). */
	newCode?: boolean
}

// The keys of an open question. Choices move with left and right and
// pick by an option's first letter (common/forms.ts step).
function question(st: FormState): Hint[] {
	let field = st.form.fields[st.focus]
	let out: Hint[] = []
	if (field?.type === 'choice' && field.options.length > 1) out.push(['←/→', 'choose'], ['first letter', 'answer'])
	if (st.form.fields.length > 1) out.push(['tab', 'next field'])
	return [...out, ['enter', 'submit'], ['esc', 'pause']]
}

// Hints painted: each key in the key color, its description dimmer.
function paint(hints: Hint[]): string {
	let h = colors.help()
	let key = ansi.sgr({ fg: h.key! })
	let desc = ansi.sgr({ fg: h.description! })
	return hints.map(([k, d]) => `${key}${k}${desc}: ${d}`).join(`${desc}, `)
}

// The painted row for a terminal `cols` wide; `resize` puts the prompt
// resize keys first among the state's hints (task 0nj).
function row(v: HelpInput, cols: number, resize = false): string {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let h = colors.help()
	let line = (text: string, fg = h.description!) => ansi.PAD + ansi.sgr({ fg }) + strings.clipVisual(text, width) + ansi.UNCOLOR
	if (v.form) return line(helpRow.paint(helpRow.question(v.form)))
	if (v.editing) return line(v.editing, colors.warning().fg!)
	if (v.choices?.length) return line(ansi.clean(v.choices.map((c) => typeof c === 'string' ? c : c[0]).join('  ')))
	let hints = sendKeys.hints(v.transcript?.state, v.prompt.text)
	if (resize) hints = [['ctrl-=/-', 'resize prompt'], ...hints]
	let left = helpRow.paint(v.newCode ? [...hints, ['ctrl-r', 'reload']] : hints)
	let right = helpRow.paint([['/keys', 'shortcuts']])
	let rw = strings.visLen(right)
	if (rw + 1 > width) return line(left)
	left = strings.clipVisual(left, width - rw - 1)
	return ansi.PAD + left + ' '.repeat(width - strings.visLen(left) - rw) + right + ansi.UNCOLOR
}

// The help area: described completion candidates one per row, at most
// `max`, then '+N more' (task 4qh); else the help row alone.
function rows(v: HelpInput, cols: number, resize = false, max = 10): string[] {
	let list = v.form || v.editing ? undefined : v.choices
	if (!list?.length || typeof list[0] === 'string') return [helpRow.row(v, cols, resize)]
	let hints = list as Hint[]
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let h = colors.help()
	let pad = Math.max(...hints.slice(0, max).map(([c]) => strings.visLen(ansi.clean(c))))
	let out = hints.slice(0, max).map(([c, d]) => ansi.PAD + strings.clipVisual(`${ansi.sgr({ fg: h.key! })}${ansi.clean(c).padEnd(pad)}  ${ansi.sgr({ fg: h.description! })}${ansi.clean(d)}`, width) + ansi.UNCOLOR)
	if (hints.length > max) out.push(ansi.PAD + ansi.sgr({ fg: h.description! }) + `+${hints.length - max} more` + ansi.UNCOLOR)
	return out
}

export const helpRow = { question, paint, row, rows }
