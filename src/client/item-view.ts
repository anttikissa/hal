// Transcript items as the frame shows them: the rows of each item and
// the style it wears. Pure.

import { attachments } from '../common/attachments.ts'
import { colors, type Style } from '../common/colors.ts'
import { forms, type Quote } from '../common/forms.ts'
import { strings } from '../common/strings.ts'
import { titles } from '../common/titles.ts'
import { transcript, type Item as Keyed, type Shown as Item } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { markdownView } from './markdown-view.ts'
import { promptView } from './prompt-view.ts'

const { INVERSE, UNINVERSE } = ansi

// The style of a tool's name: toolBash for bash, tool for one without its own.
function toolStyle(name: string): Style {
	let key = 'tool' + name.charAt(0).toUpperCase() + name.slice(1)
	let style = (colors as Record<string, unknown>)[key]
	return typeof style === 'function' ? style() : colors.tool()
}

function itemStyle(item: Item): Style | undefined {
	switch (item.type) {
		case 'prompt':
		case 'image':
			return colors.user()
		case 'text':
			return { fg: colors.assistant().fg! }
		case 'thinking':
			return { fg: colors.thinking().fg! }
		case 'tool':
			return itemView.toolStyle(item.name)
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
		case 'divider':
			return { fg: colors.log().fg! }
	}
}

// A prompt, model text or thinking as the old Hal drew it (task hp):
// its header ('10:52 Hal (Opus 5.5)'), clipped, a blank row, the body.
function headed(item: Item, body: string[], width: number): string[] {
	return [strings.clipVisual(ansi.clean(titles.title(item) ?? ''), width), '', ...body]
}

// Rows for one item at `width` columns, without the side padding;
// `streaming`: the item is still growing.
function itemLines(item: Item, width: number, streaming = false): string[] {
	let promptWidth = width - promptView.FIRST.length
	switch (item.type) {
		// A prompt card has a row of its background above the header and
		// below the body, as in the old Hal.
		case 'prompt':
			return ['', ...itemView.headed(item, ansi.wrap(item.text, width).map(ansi.links), width), '']
		case 'image':
			return [attachments.label(item)]
		// Trailing blank lines the model streamed are not drawn: the one
		// blank row between items (frame.build) is the only gap. Model
		// text is markdown (task fn).
		// Finished thinking with no readable text (redacted or empty)
		// draws nothing, not a bare header (task hp).
		case 'thinking':
			if (!item.text.trim() && !streaming) return []
		// falls through
		case 'text':
			return itemView.headed(item, markdownView.lines(item.text.trimEnd(), width, streaming, itemView.itemStyle(item)), width)
		case 'tool': {
			let { command, description } = item.input
			let row: string
			if (typeof command === 'string' && typeof description === 'string') {
				let head = strings.clipVisual(`▸ ${ansi.clean(description).replace(/\s+/g, ' ')}`, width)
				let rest = strings.clipVisual(`  $ ${ansi.clean(command).replace(/\s+/g, ' ')}`, width - strings.visLen(head))
				row = head + ansi.quiet(rest, itemView.itemStyle(item))
			} else {
				let input = ansi.clean(JSON.stringify(item.input)).replace(/\s+/g, ' ')
				row = strings.clipVisual(`▸ ${ansi.clean(item.name)} ${input}`, width)
			}
			if (!item.partial) return [row]
			let lines = item.partial.replace(/\n$/, '').split('\n').slice(-5)
			return [row, ...lines.flatMap((line) => ansi.wrap(ansi.clean(line), Math.max(1, width - 2))).slice(-5).map((line) => `  ${line}`)]
		}
		case 'tool-result': {
			// A glimpse: tool output can be long, the model sees all of it.
			let rows = ansi.wrap(item.output.replace(/\n$/, ''), Math.max(1, width - 2))
			let shown = rows.slice(0, itemView.resultRows())
			if (rows.length > shown.length) shown.push(`… ${rows.length - shown.length} more lines`)
			return shown.map((l, i) => ansi.quiet(strings.clipVisual((i ? '  ' : item.isError ? '✗ ' : '◂ ') + l, width), itemView.itemStyle(item)))
		}
		case 'turn-end':
			if (item.status === 'error') return ansi.wrap(`error: ${item.error ?? 'turn failed'}`, width)
			if (item.status === 'completed') return []
			return [`[${item.status}]`]
		case 'question': {
			let rows = [...ansi.wrap(`? ${item.form.text}`, width), ...itemView.quoteLines(item.form.quote, width)]
			let said = item.cancelled ? ['(cancelled)'] : item.answers ? forms.summary(item.form, item.answers, item.secrets) : ['(not answered)']
			return [...rows, ...said.flatMap((l) => ansi.wrap(l, width - 2).map((r) => `  ${r}`))]
		}
		case 'command': {
			let text = item.from === undefined ? item.text : `${item.text}\n(sent from ${item.from})`
			return promptView.mark(ansi.wrap(text, promptWidth))
		}
		case 'output':
			return ansi.wrap(item.text, width)
		// One row: the text centred in a rule across the width.
		case 'divider': {
			let text = strings.clipVisual(` ${item.text} `, width)
			let rest = Math.max(0, width - strings.visLen(text))
			let left = Math.floor(rest / 2)
			return ['─'.repeat(left) + text + '─'.repeat(rest - left)]
		}
	}
}

// The id `item` shows, `#35`, and where it links: the same block on
// the web, /<session>#<key> (tasks wc, 0z). Every block with a block
// id has one, except a tool result, which the web shows in its call's
// block; an item whose key is no block id has none.
function ref(item: Keyed, session: string | undefined): { text: string; href: string } | undefined {
	let href = session && item.type !== 'tool-result' ? transcript.href(session, item.key) : undefined
	return href ? { text: `#${item.key}`, href } : undefined
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
			let t = ansi.clean(p.text.replace(/\r\n?/g, '\n'))
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

export const itemView = {
	// Rows of a tool result shown in the transcript.
	resultRows: () => 3,
	toolStyle,
	itemStyle,
	itemLines,
	headed,
	ref,
	quoteLines,
}
