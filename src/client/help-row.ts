// The help row, the chrome's last row (task p0): always exactly one
// row, so the prompt never jumps when what it says changes. In
// priority order: the keys of an open question, the hint while editing
// the last prompt, tab completion's choices, else the key hints for
// the session's state (then 'ctrl-r: reload client' when a new commit
// is checked out) with '/keys: shortcuts' at the right. Keys in
// the help key colour, descriptions in its description colour, as in
// the old Hal. Pure.

import { colors } from '../common/colors.ts'
import type { FormState } from '../common/forms.ts'
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
	choices?: string[]
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

// The key hints for the session's state and whether the prompt has text.
function keys(state: SessionState | undefined, text: boolean): Hint[] {
	let working = state?.type === 'running' || state?.type === 'retrying' || state?.type === 'blocked'
	if (working && text) return [['enter', 'interrupt'], ['alt-enter', 'after this turn'], ['shift-enter', 'newline'], ['esc', 'pause']]
	if (state?.type === 'retrying' && !text) return [['enter', 'retry now'], ['esc', 'pause']]
	if (working) return [['esc', 'pause']]
	if (text) return [['enter', 'send'], ['shift-enter', 'newline'], ['alt-enter', 'after this turn']]
	if (state?.type === 'paused') return [['enter', 'continue']]
	if (state?.type === 'error') return [['enter', 'retry']]
	return []
}

// Hints painted: each key in the key colour, its description dimmer.
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
	if (v.choices?.length) return line(ansi.clean(v.choices.join('  ')))
	let hints = helpRow.keys(v.transcript?.state, v.prompt.text.trim() !== '')
	if (resize) hints = [['ctrl-=/-', 'resize prompt'], ...hints]
	let left = helpRow.paint(v.newCode ? [...hints, ['ctrl-r', 'reload client']] : hints)
	let right = helpRow.paint([['/keys', 'shortcuts']])
	let rw = strings.visLen(right)
	if (rw + 1 > width) return line(left)
	left = strings.clipVisual(left, width - rw - 1)
	return ansi.PAD + left + ' '.repeat(width - strings.visLen(left) - rw) + right + ansi.UNCOLOR
}

export const helpRow = { question, keys, paint, row }
