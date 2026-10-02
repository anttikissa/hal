// Transcript items as the frame shows them: the rows of each item and
// the style it wears. Pure.

import { attachments } from '../common/attachments.ts'
import { bashResult } from '../common/bash-result.ts'
import { colors, type Style } from '../common/colors.ts'
import { forms, type Quote } from '../common/forms.ts'
import { strings } from '../common/strings.ts'
import { titles } from '../common/titles.ts'
import { transcript, type Item as Keyed, type Shown as Item } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { markdownView } from './markdown-view.ts'
import { summary } from '../common/summary.ts'
import { names } from '../common/names.ts'

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
function headed(item: Item, body: string[], width: number, session?: string): string[] {
	let title = titles.title(item)
	if (title === undefined) return body
	title = strings.clipVisual(ansi.clean(title), width)
	let call = item.type === 'prompt' && item.label?.match(/^bash #(\d+)$/)?.[1]
	if (call && session && title.endsWith(`#${call}`)) {
		let href = transcript.href(session, call)
		if (href) title = `${title.slice(0, -call.length - 1)}${ansi.quiet(`\x1b]8;;${ansi.webUrl(href)}\x07#${call}${ansi.LINK_OFF}`, itemView.itemStyle(item))}`
	}
	return [title, '', ...body]
}

// Rows for one item at `width` columns, without the side padding;
// `streaming`: the item is still growing.
// `attached`: a tool result drawn right under its call (or another of
// its results), which needs no link back to it.
function itemLines(item: Item, width: number, streaming = false, session?: string, calls?: Map<string, string>, attached = false): string[] {
	switch (item.type) {
		// A prompt card gets its padding rows from frame.itemRows.
		case 'prompt':
			let bash = (/^bash (?:#\d+|b[0-9a-f]{6})$/.test(item.label ?? ''))
			let body = ansi.wrap(bash ? bashResult.display(item.text) : item.text, width).map(ansi.links)
			if (bash && /^\[exit [1-9]\d*\]/.test(body[0] ?? '')) {
				let status = /^\[exit [1-9]\d*\]/.exec(body[0]!)![0]
				body[0] = ansi.sgr({ fg: colors.error().fg! }) + status + ansi.sgr({ fg: colors.user().fg! }) + body[0]!.slice(status.length)
			}
			// Another session's message: its summary, then a glimpse.
			if (item.summary) {
				let more = body.length - 3
				body = [...ansi.wrap(item.summary, width), ...body.slice(0, 3).map((l) => ansi.quiet(l, itemView.itemStyle(item))), ...(more > 0 ? [`… ${more} more lines`] : [])]
			}
			return itemView.headed(item, body, width, session)
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
			return itemView.headed(item, markdownView.lines((item.type === 'text' ? names.strip(summary.strip(item.text)) : item.text).trimEnd(), width, streaming, itemView.itemStyle(item)), width)
		case 'tool': {
			let { command, description } = item.input
			let time = titles.time(item.ts)
			let prefix = time ? `${time} ` : ''
			let row: string
			if (typeof command === 'string' && typeof description === 'string') {
				let head = strings.clipVisual(`${prefix}${ansi.clean(description).replace(/\s+/g, ' ')}`, width)
				let mark = item.input.background === true ? '&' : '$'
				let commandLine = strings.clipVisual(`${mark} ${ansi.clean(command).replace(/\s+/g, ' ')}`, width)
				return [head, ansi.quiet(commandLine, itemView.itemStyle(item)), ...(item.partial ? item.partial.replace(/\n$/, '').split('\n').slice(-5).flatMap((line) => ansi.wrap(ansi.clean(line), Math.max(1, width - 2), false)).slice(-5).map((line) => `  ${line}`) : [])]
			} else {
				let input = ansi.clean(JSON.stringify(item.input)).replace(/\s+/g, ' ')
				row = strings.clipVisual(`${prefix}${ansi.clean(item.name)} ${input}`, width)
			}
			if (!item.partial) return [row]
			let lines = item.partial.replace(/\n$/, '').split('\n').slice(-5)
			return [row, ...lines.flatMap((line) => ansi.wrap(ansi.clean(line), Math.max(1, width - 2), false)).slice(-5).map((line) => `  ${line}`)]
		}
		case 'tool-result': {
			// A glimpse: tool output can be long, the model sees all of it.
			let call = calls?.get(item.id)
			let out = call ? bashResult.display(item.output) : item.output
			// Only the lines shown are laid out (outputs run to megabytes);
			// the rest are counted as source lines, as on the web.
			let wide = Math.max(1, width - 2), max = itemView.resultRows()
			let lines = out.replace(/\n$/, '').split('\n')
			let rows: string[] = []
			let used = 0
			while (used < lines.length && rows.length <= max) rows.push(...ansi.wrap(lines[used++]!.slice(0, (max + 1) * wide * 4), wide, false))
			let shown = rows.slice(0, max)
			let more = rows.length - shown.length + lines.length - used
			if (more) shown.push(`… ${more} more lines`)
			return shown.map((l, i) => {
				let prefix = i ? '  ' : item.isError ? '✗ ' : '◂ '
				let ref = !i && !attached && call && session && transcript.href(session, call)
				if (ref) prefix += `\x1b]8;;${ansi.webUrl(ref)}\x07#${call}${ansi.LINK_OFF}> `
				let line = ansi.quiet(strings.clipVisual(prefix + l, width), itemView.itemStyle(item))
				if (call && /^\[exit [1-9]\d*\]/.test(l)) {
					let status = /^\[exit [1-9]\d*\]/.exec(l)![0]
					let at = line.indexOf(status)
					if (at >= 0) line = line.slice(0, at) + ansi.sgr({ fg: colors.error().fg! }) + status + ansi.sgr({ fg: colors.quiet(itemView.itemStyle(item)!.fg!, colors.screen()) }) + line.slice(at + status.length)
				}
				return line
			})
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
		// Drawn as the prompt it was typed as: header, then its text.
		case 'command':
			return itemView.headed(item, ansi.wrap(item.text, width), width, session)
		case 'output':
			return itemView.headed(item, markdownView.lines(item.text.trimEnd(), width, streaming, itemView.itemStyle(item)), width)
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
