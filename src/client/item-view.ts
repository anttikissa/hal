// Transcript items as the frame shows them: the rows of each item and
// the style it wears. Pure. Tool calls and results: tool-view.ts.
// Tasks: fn, hp, hr, hse, a1k, 6eq, kx0, hyt.

import { interruption } from '../common/interruption.ts'
import { diff } from '../common/diff.ts'
import { diffView } from './diff-view.ts'
import { attachments } from '../common/attachments.ts'
import { card } from '../common/card.ts'
import { colors, type Style } from '../common/colors.ts'
import { forms, type Quote } from '../common/forms.ts'
import { strings } from '../common/strings.ts'
import { titles } from '../common/titles.ts'
import { transcript, type Item as Keyed, type Shown as Item } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { blockView } from './block-view.ts'
import { markdown } from '../common/markdown.ts'
import { markdownView } from './markdown-view.ts'
import { promptChanges } from '../common/prompt-changes.ts'
import type { Verbosity } from '../common/card.ts'
import { toolView } from './tool-view.ts'

// How a block is drawn (frame.look): its verbosity (task hyt), a call's
// result, whether it is padded and has a blank row above, its status,
// style, and rows a plugin draws itself.
export type Look = { headerWidth?: number; full?: boolean; fold?: Verbosity; result?: Keyed & { type: 'tool-result' }; call?: { key: string; name: string }; pad?: boolean; gap?: boolean; status?: string; style?: Style; lines?: (width: number) => string[] }

const { INVERSE, UNINVERSE } = ansi

// The style of a tool's name: toolBash for bash, tool for one without its own.
function toolStyle(name: string): Style {
	let key = 'tool' + name.charAt(0).toUpperCase() + name.slice(1)
	let style = (colors as Record<string, unknown>)[key]
	return typeof style === 'function' ? style() : colors.tool()
}

// A result keeps its originating tool's background and output color,
// whether attached to its call or drawn separately.
function itemStyle(item: Item, tool?: string): Style | undefined {
	if (item.type === 'tool-result' && tool) {
		let { fg, bg } = itemView.toolStyle(tool)
		if (!fg || !bg) return { fg: (item.isError ? colors.error() : colors.log()).fg! }
		return { fg: item.isError ? colors.error().fg! : colors.toolOutput(fg), bg }
	}
	switch (item.type) {
		case 'prompt':
			return titles.letter(item) === 'm' ? colors.message() : colors.user()
		// The human's command reads like its output (joined).
		case 'command':
			return item.from !== undefined ? colors.message() : { fg: (item.error ? colors.error() : colors.log()).fg! }
		case 'image':
			return colors.user()
		case 'text':
			return { fg: colors.assistant().fg!, code: colors.assistant().code! }
		case 'thinking':
			return { fg: colors.thinking().fg! }
		case 'tool':
			return itemView.toolStyle(item.name)
		case 'tool-result':
			return { fg: (item.isError ? colors.error() : colors.log()).fg! }
		case 'turn-end':
			return item.status === 'error' ? colors.error() : { fg: colors.log().fg! }
		case 'question':
			return colors.question()
		case 'output':
			return item.commit ? colors.commitCard() : item.error ? { fg: colors.error().fg! } : item.synthetic ? colors.synthetic() : { fg: colors.log().fg! }
		case 'divider':
			return { fg: colors.log().fg! }
	}
}

// The label links to the image itself on the web endpoint.
function imageLabel(item: Item & { type: 'image' }, session?: string): string {
	let label = attachments.label(item)
	return session ? `\x1b]8;;${ansi.webUrl(`/blob/${encodeURIComponent(session)}/${encodeURIComponent(item.blob)}`)}\x07${label}${ansi.LINK_OFF}` : label
}
function headed(item: Item, body: string[], width: number, session?: string): string[] {
	let title = titles.title(item)
	if (title === undefined) return body
	// Wrapped, a header continues at the left edge, under its time (task 77f).
	let rows = ansi.wrap(ansi.clean(title), width)
	let last = rows.at(-1)!
	let call = item.type === 'prompt' && item.label?.match(/^bash #?(t?\d+)$/)?.[1]
	if (call && session && last.endsWith(call)) {
		let href = transcript.href(session, call)
		if (href) rows[rows.length - 1] = `${last.slice(0, -call.length)}${ansi.quiet(`\x1b]8;;${ansi.webUrl(href)}\x07${call}${ansi.LINK_OFF}`, itemView.itemStyle(item))}`
	}
	return body.length ? [...rows, '', ...body] : rows
}

// Rows for one item at `width` columns, without the side padding;
// `look.fold` is its verbosity (task hyt), `look.headerWidth` what its
// title row leaves for the status and block id at its right.
// `streaming`: the text is still coming: a short block shows its last
// rows.
function itemLines(item: Item, width: number, streaming = false, session?: string, calls?: Map<string, string>, tool?: string, images: Item[] = [], look: Look = {}): string[] {
	let fold = look.fold ?? card.initial(item)
	let key = (item as { key?: string }).key ?? ''
	let hw = look.headerWidth ?? width
	switch (item.type) {
		// A prompt card gets its padding rows from frame.itemRows.
		case 'prompt':
			let source = card.text(item)
			let body = !source.trim() ? [] : card.markdown(item) ? markdownView.lines(source, width, streaming, itemView.itemStyle(item)) : ansi.wrap(source, width).map(ansi.links)
			// Another session's message: its summary, then its text quieter.
			if (fold === 'short') body = blockView.short(body, width, false, itemView.itemStyle(item))
			if (item.summary && !item.report) body = [...ansi.wrap(item.summary, width), ...body.map((l) => ansi.quiet(l, itemView.itemStyle(item)))]
			// Its images follow as labels packed into rows: a quick
			// way to open those its markers name.
			let rows: string[] = []
			for (let img of images) {
				if (img.type !== 'image') continue
				let label = attachments.label(img)
				let last = rows.length ? rows[rows.length - 1]! : undefined
				let fits = last !== undefined && strings.visLen(last) + 1 + label.length <= width
				let linked = itemView.imageLabel(img, session)
				if (fits) rows[rows.length - 1] += ' ' + linked
				else rows.push(linked)
			}
			return itemView.headed(item, rows.length ? [...body, '', ...rows] : body, hw, session)
		case 'image':
			return [itemView.imageLabel(item, session)]
		// Markdown hides trailing blanks except before interruption marks.
		// Empty thinking draws nothing, not a bare header (tasks fn, hp, 6eq).
		// Headed like a reply, so the title row holds its activity (task hyt).
		case 'thinking': {
			if (!item.text.trim() && !streaming) return []
			let body = markdownView.lines(item.text.trim(), width, streaming, itemView.itemStyle(item), session ? markdown.blockLinks(session, key) : undefined)
			if (fold === 'short') body = blockView.short(body, width, streaming, itemView.itemStyle(item))
			return itemView.headed(item, body, hw)
		}
		case 'text': {
			let text = card.text(item).trimEnd()
			if (!text.trim() && !item.interrupted) return streaming ? [''] : []
			let body = markdownView.lines(text, width, streaming, itemView.itemStyle(item), session ? markdown.blockLinks(session, key) : undefined)
			if (item.interrupted) {
				let tail = interruption.tail(item.text).replace(/\r\n?/g, '\n').split('\n')
				let last = body.pop() ?? ''
				if (tail.length === 1 && strings.visLen(last) + strings.visLen(tail[0]!) > width) { body.push(last); last = ''; tail[0] = tail[0]!.trimStart() }
				body.push(...tail.map((part, i) => (i ? '' : last) + ansi.sgr({ fg: colors.log().fg! }) + part + ansi.sgr(itemView.itemStyle(item)!)))
			}
			if (fold === 'short') body = blockView.short(body, width, streaming, itemView.itemStyle(item))
			return itemView.headed(item, body, hw)
		}
		case 'tool':
			return toolView.call(item, width, fold, look)
		case 'tool-result':
			return toolView.result(item, width, fold, look, session, calls?.get(item.id), tool)
		case 'turn-end':
			if (item.status === 'error') return ansi.wrap(titles.stamp(item.ts, `error: ${item.error ?? 'turn failed'}`), width)
			if (item.status === 'completed') return []
			return [titles.ended(item.ts, item.status)]
		case 'question': {
			// Headed by its time and text, wrapped (never clipped), then
			// the quote and the answer, as the open form draws them.
			let quote = itemView.quoteLines(item.form.quote, width)
			let said = item.canceled ? ['(canceled)'] : item.answers ? forms.summary(item.form, item.answers, item.secrets) : ['(not answered)']
			return [...ansi.wrap(titles.title(item)!, width), '', ...quote, ...(quote.length ? [''] : []), ...said.flatMap((l) => ansi.wrap(l, width - 2).map((r) => `  ${r}`))]
		}
		// Another session's: drawn as the prompt it was sent as. The
		// human's: 'HH:MM /cmd', and under it what it said, if anything.
		case 'command':
			if (item.from !== undefined) return itemView.headed(item, ansi.wrap(item.text, width), width, session)
			if (item.output === undefined) return ansi.wrap(titles.stamp(item.ts, item.text), width)
			return itemView.headed(item, markdownView.lines(item.output.trimEnd(), width, streaming, itemView.itemStyle(item)), width)
		case 'output': {
			// A commit (task 179): 'HH:MM Committed <short> <subject>';
			// open, its files and the hook's lines.
			if (item.commit) {
				let body = item.text.split('\n').flatMap((l) => ansi.wrap(l, width))
				return itemView.headed(item, fold === 'short' ? blockView.short(body, width, false, itemView.itemStyle(item)) : body, width)
			}
			// A prompt-file change (task ar): a head row and short colored
			// rows, no header; open, each change's line and whole diff.
			if (item.change) {
				let style = itemView.itemStyle(item as unknown as Item)
				let paint = (text: string, tone: Parameters<typeof diffView.paint>[1]) => diffView.paint(text, tone, style ?? colors.log(), true)
				let summary = promptChanges.rows(item).map((r) => {
					if (!r.parts) return paint(strings.clipVisual(r.text, width), r.tone)
					// Word by word, clipped to the width like a plain row.
					let room = width, out = ''
					for (let [k, p] of r.parts.entries()) {
						let gap = k > 0 ? ' ' : ''
						if (room <= gap.length) break
						let cut = strings.clipVisual(p.text, room - gap.length)
						room -= gap.length + strings.visLen(p.text)
						out += gap + paint(cut, p.tone)
					}
					return out
				})
				if (fold === 'short') return blockView.short(summary, width, false, style)
				let tone = diff.tone
				return [...summary, ...promptChanges.run(item as Keyed).flatMap((o) => ['', ansi.quiet(promptChanges.line(o), style), ...o.change!.diff.split('\n').flatMap((r) => ansi.wrap(r, width).map((w) => paint(w, tone(r))))])]
			}
			return itemView.headed(item, markdownView.lines(item.text.trimEnd(), width, streaming, itemView.itemStyle(item)), width)
		}
		// One row: the text centered in a rule across the width.
		case 'divider': {
			let text = strings.clipVisual(` ${titles.stamp(item.ts, item.text)} `, width)
			let rest = Math.max(0, width - strings.visLen(text))
			let left = Math.floor(rest / 2)
			return ['─'.repeat(left) + text + '─'.repeat(rest - left)]
		}
	}
}

// The id `item` shows, `t35` (its kind letter, task 9p), and where it
// links: the same block on the web, /<session>#t35 (tasks wc, 0z). Every block with a block
// id has one, except a tool result, which the web shows in its call's
// block; an item whose key is no block id has none.
function ref(item: Keyed, session: string | undefined): { text: string; href: string } | undefined {
	let id = titles.blockId(item)
	let href = session && item.type !== 'tool-result' ? transcript.href(session, id) : undefined
	return href ? { text: id, href } : undefined
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

// `row` with `end` at the right of `width` columns, two spaces apart
// at least; the row is clipped to make room.
function right(row: string, end: string, width: number): string {
	let room = width - strings.visLen(end) - 2
	if (room < 1) return row
	let text = strings.visLen(row) > room ? strings.clipVisual(row, room) : row
	return text + ' '.repeat(width - strings.visLen(text) - strings.visLen(end)) + end
}

// The text width beside an item's id, and how to put the id on row
// `at`, after `status` if there is one; the row is clipped to make room.
// `head`: the room the title row has left of them.
function place(item: Keyed, cols: number, session: string | undefined, style: Style | undefined, status = ''): { inner: number; head: number; mark: (lines: string[], at: number) => void } {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	status = [status, itemView.receipt(item, style)].filter(Boolean).join(' ')
	let ref = itemView.ref(item, session)
	// On a very narrow terminal the text needs every column.
	if (ref && width < 4 * strings.visLen(ref.text)) ref = undefined
	let inner = ref ? Math.max(1, width - strings.visLen(ref.text) - 1) : width
	if (item.type === 'tool' && item.name === 'edit') status = strings.clipVisual(status, Math.floor(inner / 3))
	let mark = (lines: string[], at: number) => {
		if ((!ref && !status) || lines.length <= at) return
		let link = ref ? ansi.quiet(`\x1b]8;;${ansi.webUrl(ref.href)}\x07${ref.text}${ansi.LINK_OFF}`, style) : ''
		let end = status && link ? `${status} ${link}` : status || link
		if (status) lines[at] = itemView.right(lines[at]!, end, width)
		else lines[at] += ' '.repeat(Math.max(1, width - strings.visLen(lines[at]!) - strings.visLen(ref!.text))) + link
	}
	return { inner, head: status ? Math.max(1, inner - strings.visLen(status) - 2) : inner, mark }
}

function receipt(item: Item, style?: Style): string {
	let state = titles.receipt(item)
	return state ? ansi.quiet(state === 1 ? '✓' : '✓✓', style) : ''
}

export const itemView = {
	receipt,
	toolStyle,
	itemStyle,
	itemLines,
	headed,
	imageLabel,
	ref,
	quoteLines,
	right,
	place,
}
