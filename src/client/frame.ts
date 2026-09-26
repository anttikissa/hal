// The frame: every row the terminal should show, from the first
// transcript item to the prompt, and where the cursor goes. Pure; the
// renderer (render.ts) decides how to get it onto the terminal.
//
// All history is always in the frame, never a viewport-sized slice
// (tasks/cc/terminal.md rule 3). Every row fits the terminal width, has
// its tabs expanded, and carries no control characters from the text
// it shows.

import { colors, type Style } from '../common/colors.ts'
import { forms, type FormState, type Quote } from '../common/forms.ts'
import { inbox } from '../common/inbox.ts'
import { modals, type ModalState } from '../common/modals.ts'
import { oklch } from '../common/oklch.ts'
import { strings } from '../common/strings.ts'
import { transcript, type Item, type Resumed, type Transcript } from '../common/transcript.ts'
import type { PromptState } from './prompt.ts'

export interface View {
	transcript?: Transcript
	/** Where replayed history ends: a line there says it is old. */
	resumed?: Resumed
	prompt: PromptState
	/** Prompts sent but not yet acknowledged by the host. */
	pending?: string[]
	/** A passing message for the user, such as a refused command. */
	notice?: string
	/** The open question being answered here: keys and cursor go to it. */
	form?: FormState
	/** A modal drawn over everything: keys and cursor go to it. */
	modal?: ModalState
}

export interface Frame {
	lines: string[]
	/** Where the terminal cursor belongs; row into lines, 0-based column. */
	cursor: { row: number; col: number }
	/** The first list row the modal shows, to keep as its scroll. */
	modalScroll?: number
}

// One blank column on each side of every row.
const PAD = ' '
const PROMPT_FIRST = '> '
const PROMPT_REST = '  '
const DIM = '\x1b[2m'
const UNDIM = '\x1b[22m'
const INVERSE = '\x1b[7m'
const UNINVERSE = '\x1b[27m'
const UNCOLOR = '\x1b[39;49m'
const RESET = '\x1b[0m'
const LINK_OFF = '\x1b]8;;\x07'

// The escape that switches to a style's fg and bg (truecolor).
function sgr(style: Style): string {
	let parts: string[] = []
	if (style.fg) parts.push(`38;2;${oklch.toRgb(style.fg).join(';')}`)
	if (style.bg) parts.push(`48;2;${oklch.toRgb(style.bg).join(';')}`)
	return parts.length ? `\x1b[${parts.join(';')}m` : ''
}

// A padded row in a style. With a background it is a card filling all
// `cols` columns; colour always ends with the row.
function paint(row: string, style: Style | undefined, cols: number): string {
	let on = style ? frame.sgr(style) : ''
	if (!on) return PAD + row
	let fill = style!.bg ? ' '.repeat(Math.max(0, cols - PAD.length - strings.visLen(row))) : ''
	return on + PAD + row + fill + UNCOLOR
}

// The style of a tool's name: toolBash for bash, tool for one without its own.
function toolStyle(name: string): Style {
	let key = 'tool' + name.charAt(0).toUpperCase() + name.slice(1)
	let style = (colors as Record<string, unknown>)[key]
	return typeof style === 'function' ? style() : colors.tool()
}

function itemStyle(item: Item): Style | undefined {
	switch (item.type) {
		case 'prompt':
			return colors.user()
		case 'text':
			return { fg: colors.assistant().fg! }
		case 'thinking':
			return { fg: colors.thinking().fg! }
		case 'tool':
			return frame.toolStyle(item.name)
		case 'tool-result':
			return { fg: (item.isError ? colors.error() : colors.log()).fg! }
		case 'turn-end':
			return item.status === 'error' ? colors.error() : { fg: colors.log().fg! }
		case 'question':
			return colors.warning()
		case 'command':
			return colors.user()
		case 'output':
			return { fg: (item.error ? colors.error() : colors.log()).fg! }
	}
}

// Text from the model, tools or a paste must not drive the terminal:
// control characters other than newline and tab become visible. Keeps
// offsets, so a prompt cursor still points at the same place.
function clean(s: string): string {
	return s.replace(/(?![\n\t])\p{Cc}/gu, '\ufffd')
}

function wrap(text: string, width: number): string[] {
	return strings.wordWrap(strings.expandTabs(frame.clean(text.replace(/\r\n?/g, '\n'))), width)
}

// Rows for one item at `width` columns, without the side padding.
function itemLines(item: Item, width: number): string[] {
	switch (item.type) {
		case 'prompt':
			return frame.wrap(item.text, width - PROMPT_FIRST.length).map((l, i) => (i ? PROMPT_REST : PROMPT_FIRST) + l)
		case 'text':
			return frame.wrap(item.text, width)
		case 'thinking':
			return frame.wrap(item.text, width)
		case 'tool': {
			let { command, description } = item.input
			// A described command: the sentence first, the command dimmed beside it.
			if (typeof command === 'string' && typeof description === 'string') {
				let head = strings.clipVisual(`▸ ${frame.clean(description).replace(/\s+/g, ' ')}`, width)
				let rest = strings.clipVisual(`  $ ${frame.clean(command).replace(/\s+/g, ' ')}`, width - strings.visLen(head))
				return [head + (rest ? DIM + rest + UNDIM : '')]
			}
			let input = frame.clean(JSON.stringify(item.input)).replace(/\s+/g, ' ')
			return [strings.clipVisual(`▸ ${frame.clean(item.name)} ${input}`, width)]
		}
		case 'tool-result': {
			// A glimpse: tool output can be long, the model sees all of it.
			let rows = frame.wrap(item.output.replace(/\n$/, ''), Math.max(1, width - 2))
			let shown = rows.slice(0, frame.resultRows())
			if (rows.length > shown.length) shown.push(`… ${rows.length - shown.length} more lines`)
			return shown.map((l, i) => DIM + strings.clipVisual((i ? '  ' : item.isError ? '✗ ' : '◂ ') + l, width) + UNDIM)
		}
		case 'turn-end':
			if (item.status === 'error') return frame.wrap(`error: ${item.error ?? 'turn failed'}`, width)
			if (item.status === 'completed') return []
			return [`[${item.status}]`]
		case 'question': {
			let rows = [...frame.wrap(`? ${item.form.text}`, width), ...frame.quoteLines(item.form.quote, width)]
			let said = item.cancelled ? ['(cancelled)'] : item.answers ? forms.summary(item.form, item.answers, item.secrets) : ['(not answered)']
			return [...rows, ...said.flatMap((l) => frame.wrap(l, width - 2).map((r) => `  ${r}`))]
		}
		case 'command': {
			let text = item.from === undefined ? item.text : `${item.text}\n(sent from ${item.from})`
			return frame.wrap(text, width - PROMPT_FIRST.length).map((l, i) => (i ? PROMPT_REST : PROMPT_FIRST) + l)
		}
		case 'output':
			return frame.wrap(item.text, width)
	}
}

// Rows of a question's quote, indented, its marked parts in inverse.
// Each row closes what it opens and reopens what it continues, so a
// repaint of one row never leaks inverse into another.
function quoteLines(quote: Quote | undefined, width: number): string[] {
	if (!quote) return []
	let indent = '    '
	let text = forms
		.quoteParts(quote)
		.map((p) => {
			let t = frame.clean(p.text.replace(/\r\n?/g, '\n'))
			return p.marked ? t.split('\n').map((l) => INVERSE + l + UNINVERSE).join('\n') : t
		})
		.join('')
	let on = false
	return strings.wordWrap(strings.expandTabs(text), Math.max(1, width - indent.length)).map((r) => {
		let row = (on ? INVERSE : '') + r
		let opened = r.lastIndexOf(INVERSE)
		let closed = r.lastIndexOf(UNINVERSE)
		if (opened !== closed) on = opened > closed
		return indent + row + (on ? UNINVERSE : '')
	})
}

/**
 * Rows of an open question being filled in, at `width` columns, and
 * where the cursor goes in them: in the focused text, or on the
 * selected option.
 */
function formLines(st: FormState, width: number): { rows: string[]; cursor: { row: number; col: number } } {
	let rows = [...frame.wrap(`? ${st.form.text}`, width), ...frame.quoteLines(st.form.quote, width)]
	let f = frame.fieldLines(st, width)
	let hint = st.form.fields.length > 1 ? 'Enter: next · Tab: move · Escape: pause' : 'Enter: answer · Escape: pause'
	let cursor = { row: rows.length + f.cursor.row, col: f.cursor.col }
	return { rows: [...rows, ...f.rows, DIM + strings.clipVisual(`  ${hint}`, width) + UNDIM], cursor }
}

// Rows of a form's fields alone, and the cursor in them.
function fieldLines(st: FormState, width: number): { rows: string[]; cursor: { row: number; col: number } } {
	let rows: string[] = []
	let cursor = { row: 0, col: 0 }
	st.form.fields.forEach((field, i) => {
		let head = `  ${field.label ? `${frame.clean(field.label)}: ` : ''}`
		let value = st.values[i]!
		let focused = i === st.focus
		if (field.type === 'choice') {
			let col = strings.visLen(head)
			let parts = field.options.map((o) => {
				let label = ` ${frame.clean(o)} `
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
		let p = frame.layoutPrompt(shown, at, Math.max(1, width - indent))
		if (!value && field.type === 'text' && field.placeholder) p.rows[0] = DIM + strings.clipVisual(frame.clean(field.placeholder), width - indent) + UNDIM
		if (focused) cursor = { row: rows.length + p.row, col: indent + p.col }
		p.rows.forEach((r, j) => rows.push((j ? ' '.repeat(indent) : strings.clipVisual(head, indent)) + r))
	})
	return { rows, cursor }
}

/**
 * Where a modal goes on a terminal of `rows` × `cols`: a fixed height
 * (80% of the rows, at most 50) and width, centred across. Outside it
 * on each side: at least one blank column and one of transcript.
 */
function modalBox(rows: number, cols: number): { height: number; width: number; left: number } {
	let height = Math.min(rows, Math.max(3, Math.min(50, Math.floor(rows * 0.8))))
	let width = cols < 10 ? cols : Math.min(100, cols - 2 * Math.max(2, Math.round(cols * 0.1)))
	return { height, width, left: Math.floor((cols - width) / 2) }
}

// A border row: `fill` between the corners, with `text` after its first
// two columns and `right` before its last two.
function border(l: string, r: string, text: string, right: string, width: number): string {
	let inner = width - 2
	right = right && right.length + 2 <= inner - 2 ? ` ${right} ` : ''
	text = strings.clipVisual(text ? ` ${frame.clean(text)} ` : '', Math.max(0, inner - 2 - strings.visLen(right)))
	let fill = Math.max(0, inner - 2 - strings.visLen(text) - strings.visLen(right))
	return l + (inner > 0 ? '─' : '') + text + '─'.repeat(fill) + right + (inner > 1 ? '─' : '') + r
}

/**
 * All rows of a modal box `width` × `height`, outline included, and
 * where the cursor goes in them: in the focused field, else on the
 * selected item. The fields stay at the top; the list scrolls below
 * them, from `scroll` as little as it must to show the selection.
 */
function modalLines(m: ModalState, width: number, height: number): { rows: string[]; cursor: { row: number; col: number }; scroll: number } {
	let inner = Math.max(0, width - 4)
	let fields = m.form ? frame.fieldLines(m.form, inner) : { rows: [], cursor: undefined }
	let content = fields.rows.slice(0, height - 2)
	let visible = Math.max(0, height - 2 - content.length)
	let scroll = frame.modalScroll(m, visible)
	let current = colors.popupCurrent()
	let cursor = fields.cursor ?? { row: content.length, col: 0 }
	for (let i = scroll; i < Math.min(m.items.length, scroll + visible); i++) {
		let row = strings.clipVisual((i === m.selected ? '> ' : '  ') + frame.clean(m.items[i]!).replace(/\s+/g, ' '), inner)
		if (i === m.selected) {
			if (!fields.cursor) cursor = { row: content.length, col: 0 }
			row = frame.sgr(current) + row + ' '.repeat(inner - strings.visLen(row)) + UNCOLOR
		}
		content.push(row)
	}
	let line = frame.sgr({ fg: colors.popup().neutralFg! })
	let side = (s: string) => (width >= 2 ? line + s + UNCOLOR : '')
	let pad = (s: string) => {
		if (width < 4) return ' '.repeat(Math.max(0, width - 2))
		let fit = strings.clipVisual(s, inner)
		return ' ' + fit + RESET + ' '.repeat(inner - strings.visLen(fit)) + ' '
	}
	let below = m.items.length - scroll - visible
	let place = scroll > 0 || below > 0 ? `${m.selected + 1}/${m.items.length}` : ''
	let rows = [line + frame.border('╭', '╮', m.title, '', width) + UNCOLOR]
	for (let r = 0; r < height - 2; r++) rows.push(side('│') + pad(content[r] ?? '') + side('│'))
	rows.push(line + frame.border('╰', '╯', m.hint ?? '', place, width) + UNCOLOR)
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

/**
 * Lay out prompt text in rows of `width` columns, hard-wrapped, and find
 * the row and column of the cursor offset. A cursor after a full row
 * sits in the column just past it, which is the right padding.
 */
function layoutPrompt(text: string, cursor: number, width: number): { rows: string[]; row: number; col: number } {
	text = frame.clean(text)
	let rows: string[] = []
	let row = ''
	let col = 0
	let at: { row: number; col: number } | undefined
	let i = 0
	while (i < text.length) {
		if (text[i] === '\n') {
			if (!at && i >= cursor) at = { row: rows.length, col }
			rows.push(row)
			row = ''
			col = 0
			i++
			continue
		}
		let g = strings.glyphAt(text, i, col)
		if (col + g.width > width && col > 0) {
			rows.push(row)
			row = ''
			col = 0
			g = strings.glyphAt(text, i, col)
		}
		// A tab never reaches past the row.
		if (text[i] === '\t') g = { width: Math.max(1, Math.min(g.width, width - col)), length: 1 }
		if (!at && i >= cursor) at = { row: rows.length, col }
		row += text[i] === '\t' ? ' '.repeat(g.width) : text.slice(i, i + g.length)
		col += g.width
		i += g.length
	}
	at ??= { row: rows.length, col }
	rows.push(row)
	return { rows, ...at }
}

// The frame for `view` on a terminal of `rows` × `cols`.
function build(view: View, cols: number, rows = 24): Frame {
	let width = Math.max(1, cols - 2 * PAD.length)
	let lines: string[] = []
	let block = (rows: string[], style: Style | undefined) => {
		if (!rows.length) return
		if (lines.length) lines.push('')
		for (let r of rows) lines.push(frame.paint(r, style, cols))
	}
	let items = view.transcript?.items ?? []
	let formCursor: Frame['cursor'] | undefined
	for (let i = 0; i <= items.length; i++) {
		if (i === view.resumed?.at) block(frame.wrap(transcript.resumedLabel(view.resumed), width), { fg: colors.log().fg! })
		if (i >= items.length) continue
		let item = items[i]!
		if (item.type === 'question' && view.form?.id === item.id) {
			let f = frame.formLines(view.form, width)
			block(f.rows, frame.itemStyle(item))
			formCursor = { row: lines.length - f.rows.length + f.cursor.row, col: PAD.length + f.cursor.col }
		} else block(frame.itemLines(item, width), frame.itemStyle(item))
	}
	for (let text of view.pending ?? []) {
		let rows = frame.itemLines({ type: 'prompt', text }, width)
		rows.push(`${PROMPT_REST}${DIM}sending…${UNDIM}`)
		block(rows, colors.user())
	}
	// The inbox, always in view above the prompt.
	let t = view.transcript
	for (let m of t?.inbox ?? []) block(frame.wrap(`${inbox.label(t!.state, m)}: ${m.text}`, width), { fg: colors.log().fg! })
	if (view.notice) block(frame.wrap(view.notice, width), { fg: colors.log().fg! })
	if (lines.length) lines.push('')
	let promptWidth = Math.max(1, width - PROMPT_FIRST.length)
	let p = frame.layoutPrompt(view.prompt.text, view.prompt.cursor, promptWidth)
	let top = lines.length
	let input = colors.input()
	p.rows.forEach((r, i) => lines.push(frame.paint((i ? PROMPT_REST : PROMPT_FIRST) + r, input, cols)))
	let cursor = formCursor ?? { row: top + p.row, col: PAD.length + PROMPT_FIRST.length + p.col }
	if (!view.modal) return { lines, cursor }
	let m = frame.withModal(lines, view.modal, rows, cols)
	return { lines, cursor: m.cursor, modalScroll: m.scroll }
}

// Draws modal `m` over `lines`, centred on the screen (the last `rows`
// of them), so that it never reaches into scrollback. A short frame
// grows to hold it. Returns the cursor and the list's scroll.
function withModal(lines: string[], m: ModalState, rows: number, cols: number): { cursor: Frame['cursor']; scroll: number } {
	let box = frame.modalBox(rows, cols)
	while (lines.length < box.height) lines.push('')
	let screen = Math.min(lines.length, rows)
	let top = lines.length - screen + Math.floor((screen - box.height) / 2)
	let drawn = frame.modalLines(m, box.width, box.height)
	drawn.rows.forEach((r, i) => (lines[top + i] = frame.overlay(lines[top + i]!, r, box.left, box.width, cols)))
	return { cursor: { row: top + drawn.cursor.row, col: box.left + drawn.cursor.col }, scroll: drawn.scroll }
}

export const frame = {
	// Rows of a tool result shown in the transcript.
	resultRows: () => 3,
	clean,
	wrap,
	sgr,
	paint,
	toolStyle,
	itemStyle,
	itemLines,
	quoteLines,
	formLines,
	fieldLines,
	layoutPrompt,
	modalBox,
	border,
	modalLines,
	modalScroll,
	overlay,
	build,
	withModal,
}
