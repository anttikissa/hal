// Transcript items as the frame shows them: the rows of each item and
// the style it wears. Pure.
// Tasks: fn, hp, hr, hse, a1k, 6eq, kx0.

import { interruption } from '../common/interruption.ts'
import { diff } from '../common/diff.ts'
import { diffView } from './diff-view.ts'
import { attachments } from '../common/attachments.ts'
import { bashResult } from '../common/bash-result.ts'
import { colors, type Style } from '../common/colors.ts'
import { forms, type Quote } from '../common/forms.ts'
import { strings } from '../common/strings.ts'
import { titles } from '../common/titles.ts'
import { toolDetails } from '../common/tool-details.ts'
import { transcript, type Item as Keyed, type Shown as Item } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { markdown } from '../common/markdown.ts'
import { markdownView } from './markdown-view.ts'
import { summary } from '../common/summary.ts'
import { promptChanges } from '../common/prompt-changes.ts'
import type { Fold } from '../common/toggle.ts'
import { resolve } from 'path'

// A block's fold state when toggled (task ghs), and the paste texts a
// prompt shown inline needs (client/folds.ts).
export type Look = { headerWidth?: number; full?: boolean; fold?: Fold; pastes?: Map<string, { text?: string; error?: string }> }

const { INVERSE, UNINVERSE } = ansi

// The style of a tool's name: toolBash for bash, tool for one without its own.
function toolStyle(name: string): Style {
	let key = 'tool' + name.charAt(0).toUpperCase() + name.slice(1)
	let style = (colors as Record<string, unknown>)[key]
	return typeof style === 'function' ? style() : colors.tool()
}

// `tool`: the call a tool result is drawn under (attached), whose card
// it continues on the same background, its text darker than the call's
// (less luminant, not less vivid) but well above 4.5:1.
function itemStyle(item: Item, tool?: string): Style | undefined {
	if (item.type === 'tool-result' && tool) {
		let { fg, bg } = itemView.toolStyle(tool)
		if (!fg || !bg) return { fg: (item.isError ? colors.error() : colors.log()).fg! }
		return { fg: item.isError ? colors.error().fg! : colors.toolOutput(fg), bg }
	}
	switch (item.type) {
		case 'prompt':
		case 'command':
			return titles.letter(item) === 'm' ? colors.message() : colors.user()
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
			return item.error ? { fg: colors.error().fg! } : item.synthetic ? colors.synthetic() : { fg: colors.log().fg! }
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
	let call = item.type === 'prompt' && item.label?.match(/^bash #(t?\d+)$/)?.[1]
	if (call && session && last.endsWith(`#${call}`)) {
		let href = transcript.href(session, call)
		if (href) rows[rows.length - 1] = `${last.slice(0, -call.length - 1)}${ansi.quiet(`\x1b]8;;${ansi.webUrl(href)}\x07#${call}${ansi.LINK_OFF}`, itemView.itemStyle(item))}`
	}
	return [...rows, '', ...body]
}

// Rows for one item at `width` columns, without the side padding;
// `streaming`: the item is still growing.
// `tool`: the name of the call a tool result is drawn right under (or
// under another of its results); attached, it needs no link back.
// `images`: the image items of a prompt, drawn in its card (frame.layout).
// `look`: the block's fold state, when toggled (task ghs), and the
// pastes a prompt shown inline needs.
function itemLines(item: Item, width: number, streaming = false, session?: string, calls?: Map<string, string>, tool?: string, images: Item[] = [], look: Look = {}): string[] {
	let fold = look.fold
	let key = (item as { key?: string }).key ?? ''
	switch (item.type) {
		// A prompt card gets its padding rows from frame.itemRows.
		case 'prompt':
			let source = bashResult.background(item) ? bashResult.display(item.text) : item.summary ? summary.strip(item.text) : item.text
			if (fold === 'inline') source = itemView.inlined(source, look.pastes)
			if (fold === 'closed' && !item.summary) return itemView.closedRow(item, source, width)
			let body = ansi.wrap(source, width).map(ansi.links)
			// Another session's message: its summary, then a glimpse;
			// opened, its whole text.
			if (item.summary && (fold ?? 'closed') !== 'closed') body = [...ansi.wrap(item.summary, width), ...body.map((l) => ansi.quiet(l, itemView.itemStyle(item)))]
			else if (item.summary) {
				let more = body.length - 3
				body = [...ansi.wrap(item.summary, width), ...body.slice(0, 3).map((l) => ansi.quiet(l, itemView.itemStyle(item))), ...(more > 0 ? [`… ${more} more lines`] : [])]
			}
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
			return itemView.headed(item, rows.length ? [...body, '', ...rows] : body, look.headerWidth ?? width, session)
		case 'image':
			return [itemView.imageLabel(item, session)]
		// Markdown hides trailing blanks except before interruption marks.
		// Empty thinking draws nothing, not a bare header (tasks fn, hp, 6eq).
		case 'thinking': {
			if (!item.text.trim() && !streaming) return []
			let prefix = titles.stamp(item.ts, item.originSession ? `(in ${item.originSession}) ` : '')
			if (fold === 'closed' && !streaming) return itemView.closedRow(item, item.text, width, prefix)
			// The time leads the first paragraph, so wrapped rows continue at
			// the left edge (task 77f); before a heading, list or code it
			// stands on its own row.
			let text = item.text.trim()
			let first = markdown.parse(text.split('\n', 1)[0]!, false)[0]
			let flows = first?.type === 'line' && first.kind === 'p' && !first.marker
			let body = markdownView.lines(flows ? prefix + text : text, width, streaming, itemView.itemStyle(item), session ? markdown.blockLinks(session, key) : undefined)
			return flows ? body : [...ansi.wrap(prefix.trimEnd(), width), ...body]
		}
		case 'text': {
			let text = summary.answer(item.text).trimEnd()
			if (!text.trim() && !item.interrupted) return streaming ? [''] : []
			if (fold === 'closed' && !streaming) return itemView.closedRow(item, text, width)
			let body = markdownView.lines(text, width, streaming, itemView.itemStyle(item), session ? markdown.blockLinks(session, key) : undefined)
			if (item.interrupted) {
				let tail = interruption.tail(item.text).replace(/\r\n?/g, '\n').split('\n')
				let last = body.pop() ?? ''
				if (tail.length === 1 && strings.visLen(last) + strings.visLen(tail[0]!) > width) { body.push(last); last = ''; tail[0] = tail[0]!.trimStart() }
				body.push(...tail.map((part, i) => (i ? '' : last) + ansi.sgr({ fg: colors.log().fg! }) + part + ansi.sgr(itemView.itemStyle(item)!)))
			}
			return itemView.headed(item, body, width)
		}
		case 'tool': {
			let { command, description } = item.input
			let prefix = titles.stamp(item.ts, '')
			if (toolDetails.fullCommand(item.name, item.input)) {
				if (fold !== 'open') return [strings.clipVisual(prefix + ansi.clean(String(command)), width)]
				return [String(command), ...toolDetails.lines(item.name, item.input)].flatMap((line) => ansi.wrap(line, width))
			}
			let row: string
			if (typeof command === 'string' && typeof description === 'string') {
				let head = itemView.unsafe(strings.clipVisual(`${prefix}${ansi.clean(toolDetails.headline(item.name, item.input).text)}`, width), item, width)
				if (fold === 'closed') return [head]
				let mark = item.input.background === true ? '&' : '$'
				let commandLine = strings.clipVisual(`${mark} ${ansi.clean(command).replace(/\s+/g, ' ')}`, width)
				// Running output is laid out as its result glimpse will be
				// (a blank row, then resultRows rows), so the card does not
				// shrink when the call finishes (task 4y4).
				let n = itemView.resultRows
				let live = item.partial ? item.partial.replace(/\n$/, '').split('\n').slice(-n).flatMap((line) => ansi.wrap(ansi.clean(line), width, false)).slice(-n) : []
				return [head, ansi.quiet(commandLine, itemView.itemStyle(item)), ...(live.length ? ['', ...live] : [])]
			} else {
				row = strings.clipVisual(`${prefix}${ansi.clean(toolDetails.headline(item.name, item.input).text)}`, width)
			}
			if (!item.partial) return [row]
			let lines = item.partial.replace(/\n$/, '').split('\n').slice(-5)
			return [row, ...lines.flatMap((line) => ansi.wrap(ansi.clean(line), width, false)).slice(-5)]
		}
		case 'tool-result': {
			// A glimpse: tool output can be long, the model sees all of it.
			let call = calls?.get(item.id)
			// A canceled call's note to the model: the title says "(canceled)".
			let out = item.interrupted === 'canceled' ? '' : call ? bashResult.display(item.output, !!item.interrupted) : bashResult.trim(item.output)
			let style = itemView.itemStyle(item, tool)
			// Attached, nothing to show draws nothing; apart, the header
			// row stays, for its time, link and status. A closed call is
			// its header row (task ghs): attached results draw nothing.
			if (tool && (fold === 'closed' || (!out && !item.isError))) return []
			let wide = width, max = fold === 'open' ? look.full ? Infinity : itemView.openRows : itemView.resultRows
			let lines = out.split('\n')
			let rows: string[] = []
			let used = 0
			while (used < lines.length && rows.length <= max) rows.push(...ansi.wrap(lines[used++]!.slice(0, (max + 1) * wide * 4), wide, false))
			let shown = rows.slice(0, max)
			let more = rows.length - shown.length + lines.length - used
			let status = tool ? '' : itemView.resultStatus(item, !!call, style)
			let res = shown.map((l, i) => {
				let prefix = !i && item.isError ? '✗ ' : ''
				// Apart from its call, a result is its own block: it leads with its time.
				if (!i && !tool) prefix = titles.stamp(item.ts, prefix)
				let ref = !i && !tool && call && session && transcript.href(session, `t${call}`)
				if (ref) prefix += `\x1b]8;;${ansi.webUrl(ref)}\x07#t${call}${ansi.LINK_OFF}> `
				let text = strings.clipVisual(prefix + l, width)
				let line = tool ? text : ansi.quiet(text, style)
				return !i && status ? itemView.right(line, status, width) : line
			})
			if (more) {
				let marker = ansi.quiet(`… ${more} more lines${fold === 'open' ? ` in ${itemView.fullAt(item.output, session, (item as Partial<Keyed>).key)}` : ''}`, style)
				let last = res.at(-1)!
				if (strings.visLen(last) + 2 + strings.visLen(marker) <= width) res[res.length - 1] = itemView.right(last, marker, width)
				else res.push(marker)
			}
			return res
		}
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
		// Drawn as the prompt it was typed as: header, then its text.
		case 'command':
			return itemView.headed(item, ansi.wrap(item.text, width), width, session)
		case 'output': {
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
				if (fold !== 'open') return summary
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

// The id `item` shows, `#t35` (its kind letter, task 9p), and where it
// links: the same block on the web, /<session>#t35 (tasks wc, 0z). Every block with a block
// id has one, except a tool result, which the web shows in its call's
// block; an item whose key is no block id has none.
function ref(item: Keyed, session: string | undefined): { text: string; href: string } | undefined {
	let id = titles.blockId(item)
	let href = session && item.type !== 'tool-result' ? transcript.href(session, id) : undefined
	return href ? { text: `#${id}`, href } : undefined
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

// A flagged call's title row with an italic "unsafe to stop" in the
// title's own color, never red (task ker); clipped to make room.
function unsafe(row: string, item: Item & { type: 'tool' }, width: number): string {
	let label = 'unsafe to stop'
	if (!toolDetails.unsafe(item.name, item.input) || width < 3 * label.length) return row
	return `${strings.clipVisual(row, width - label.length - 2)}  \x1b[3m${label}\x1b[23m`
}

// `text` in the exit color, then back to `style`'s.
function exitColor(text: string, style: Style | undefined): string {
	if (ansi.mono()) return text
	return ansi.sgr({ fg: colors.exit().fg! }) + text + (style?.fg ? ansi.sgr({ fg: style.fg }) : '\x1b[39m')
}

// The status after a tool card's title (task wm0), quiet: a nonzero
// exit in the exit color, then the time; '' with neither.
function status(exit: string | undefined, time: string | undefined, style: Style | undefined): string {
	if (!exit && !time) return ''
	if (!exit) return ansi.quiet(`(${time})`, style)
	return ansi.quiet('(', style) + itemView.exitColor(exit, style) + ansi.quiet(time ? `, ${time})` : ')', style)
}

// A finished call's status from its result; `bash`: a bash call's.
// Steering's "(canceled)" or "(stopped, 50.2s)" is quiet: no failure.
function resultStatus(item: { output: string; ms?: number; interrupted?: 'canceled' | 'stopped' }, bash: boolean, style: Style | undefined): string {
	let text = bashResult.interrupted(item)
	if (text) return ansi.quiet(`(${text})`, style)
	return itemView.status(bash ? bashResult.status(item.output) : undefined, bashResult.duration(item.ms), style)
}

// `row` with `end` at the right of `width` columns, two spaces apart
// at least; the row is clipped to make room.
function right(row: string, end: string, width: number): string {
	let room = width - strings.visLen(end) - 2
	if (room < 1) return row
	let text = strings.visLen(row) > room ? strings.clipVisual(row, room) : row
	return text + ' '.repeat(width - strings.visLen(text) - strings.visLen(end)) + end
}

// Text with each [paste/<name>] marker replaced by that paste's text;
// one not here yet, or missing, keeps its marker and says so.
function inlined(text: string, pastes: Look['pastes']): string {
	return text.replace(/\[paste\/([0-9a-z]{6}\.[a-z0-9]{1,8})\]/g, (marker, name: string) => {
		let got = pastes?.get(name)
		return got?.text !== undefined ? bashResult.trim(got.text) : `${marker} (${got?.error ?? 'loading…'})`
	})
}

// A closed block's one row (task ghs): its title (or `head`), then the
// start of its text, quiet.
function closedRow(item: Item, text: string, width: number, head = (titles.title(item) ?? '') + ' '): string[] {
	head = ansi.clean(head)
	let first = ansi.clean(text.split('\n').find((l) => l.trim()) ?? '').trim()
	let row = strings.expandTabs(strings.clipVisual(head + first, width))
	return [row.length > head.length ? row.slice(0, head.length) + ansi.quiet(row.slice(head.length), itemView.itemStyle(item)) : row]
}

// Where an open result's whole output is: the file its cut note names,
// else its line in the session's history file.
function fullAt(output: string, session: string | undefined, key = ''): string {
	let cut = /cat (\S+)\]\s*$/.exec(output)?.[1]
	if (cut) return cut
	let home = process.env.HAL_HOME ?? resolve(import.meta.dir, '../..')
	let path = `${home}/sessions/${session ?? '?'}/history.asonl`
	if (process.env.HOME && path.startsWith(process.env.HOME + '/')) path = '~' + path.slice(process.env.HOME.length)
	return `${path} line ${/^\d+/.exec(key)?.[0] ?? '?'}`
}

export const itemView = {
	// Rows of a tool result shown in the transcript: closed, and opened.
	resultRows: 3,
	openRows: 200,
	inlined,
	closedRow,
	fullAt,
	toolStyle,
	itemStyle,
	itemLines,
	headed,
	imageLabel,
	ref,
	quoteLines,
	unsafe,
	exitColor,
	status,
	resultStatus,
	right,
}
