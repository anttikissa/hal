// Tool calls and their results as the terminal draws them (tasks wm0,
// ghs, 4y4, hyt): short is settings.shortRows() rows, title included
// (bash-card.ts for Bash's), long all of them. Pure.

import { bashResult } from '../common/bash-result.ts'
import { colors, type Style } from '../common/colors.ts'
import { diff } from '../common/diff.ts'
import { settings } from '../common/settings.ts'
import { strings } from '../common/strings.ts'
import type { Verbosity } from '../common/card.ts'
import { titles } from '../common/titles.ts'
import { toolDetails } from '../common/tool-details.ts'
import { transcript, type Item as Keyed, type Shown as Item } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { bashCard } from './bash-card.ts'
import { diffView } from './diff-view.ts'
import { itemView, type Look } from './item-view.ts'
import { presentationView } from './tool-presentation.ts'
import { resolve } from 'path'

// A call's rows. Its result's status and the activity cell sit at the
// right of the first row (frame.ref), which look.headerWidth leaves.
// A command shown whole (/help), short, is its one row.
function call(item: Item & { type: 'tool' }, width: number, fold: Verbosity, look: Look): string[] {
	let { command } = item.input
	let prefix = titles.stamp(item.ts, '')
	let hw = look.headerWidth ?? width
	if (toolDetails.fullCommand(item.name, item.input)) {
		if (fold === 'short') return [strings.expandTabs(strings.clipVisual(prefix + ansi.clean(String(command)), hw))]
		return [String(command), ...toolDetails.lines(item.name, item.input)].flatMap((line) => ansi.wrap(line, width))
	}
	let title = ansi.clean(look.result?.presentation?.title ?? item.presentation?.title ?? toolDetails.headline(item.name, item.input, look.result?.output).text)
	let head = toolView.unsafe(strings.clipVisual(prefix + title, hw), item, hw)
	if (item.presentation || item.presentationError || look.result?.presentation || look.result?.presentationError) return presentationView.call(item, head, width, fold, look.result, itemView.itemStyle(item))
	let bash = item.name === 'bash'
	if (fold === 'long') {
		let rows = ansi.wrap(prefix + title, hw)
		rows[0] = toolView.unsafe(rows[0]!, item, hw)
		return [...rows, ...toolDetails.lines(item.name, item.input).flatMap((line) => ansi.wrap(ansi.clean(line), width)), ...(item.partial ? ansi.wrap(ansi.clean(item.partial.replace(/\n$/, '')), width) : [])]
	}
	// Running output takes the rows its short result will, so the card
	// keeps its height when the call finishes (task 4y4).
	let n = settings.shortRows()
	let top = [head]
	if (bash) {
		let ms = look.now === undefined || !item.ts ? Infinity : look.now - Date.parse(item.ts)
		let described = typeof item.input.description === 'string' && item.input.description.trim() !== ''
		let shown = described || (typeof command === 'string' && command.trim().includes('\n')) ? command : undefined
		top = bashCard.head(head, shown, width, hw, n, ms, itemView.itemStyle(item))
		let commandRows = typeof command === 'string' ? command.split('\n').length : 0
		// Declared files and other details while a row stays for output.
		for (let line of toolDetails.lines(item.name, item.input).slice(commandRows)) if (top.length < n - 1) top.push(strings.expandTabs(strings.clipVisual(ansi.clean(line), width)))
	}
	toolView.heads.set(item, top.length)
	let room = n - top.length
	let live = room > 0 && item.partial ? item.partial.replace(/\n$/, '').split('\n').slice(-room).flatMap((line) => ansi.wrap(ansi.clean(line), width, false)).slice(-room) : []
	return [...top, ...live]
}

// A result's rows: `call` the id of the bash call it answers (its output
// is a bash display), `tool` the call's name when drawn under it. A
// whole command's result (look.full) draws nothing under its short call;
// apart, its header row stays, for its time, link and status.
function result(item: Item & { type: 'tool-result' }, width: number, fold: Verbosity, look: Look, session: string | undefined, call: string | undefined, tool: string | undefined): string[] {
	// A canceled call's note to the model: the title says "(canceled)".
	let out = item.interrupted === 'canceled' ? '' : call ? bashResult.display(item.output, !!item.interrupted) : bashResult.trim(item.output)
	let style = look.style ?? itemView.itemStyle(item, tool)
	if (tool && ((fold === 'short' && look.full) || (!out && !item.isError && !item.presentation && !item.presentationError))) return []
	if (tool && (item.presentation || item.presentationError) && fold === 'long') return [...(item.presentationError ? ansi.wrap(ansi.clean(item.presentationError), width) : []), ...(item.isError || !item.presentation ? ansi.wrap(ansi.clean(out), width) : presentationView.lines(item.presentation, item.output, width, style))]
	// Under its short call, a result fills the rows the call leaves.
	let max = look.full ? Infinity : fold === 'long' ? toolView.openRows : settings.shortRows() - (tool ? look.head ?? 1 : 0)
	if (max <= 0) return []
	// An attached EDIT result shows its diff in diff colors; running
	// output apart from its call (task 5gn), its last lines.
	let painted = tool && item.diff, lines = (painted || out).split('\n'), tones: ReturnType<typeof diff.tone>[] = []
	if ((item as { live?: boolean }).live && max !== Infinity) lines = lines.slice(-max)
	let rows: string[] = [], used = 0
	while (used < lines.length && rows.length <= max) {
		let line = lines[used++]!, wrapped = ansi.wrap(line.slice(0, (max + 1) * width * 4), width, false)
		rows.push(...wrapped)
		tones.push(...wrapped.map(() => diff.tone(line)))
	}
	let shown = rows.slice(0, max)
	let more = rows.length - shown.length + lines.length - used
	let status = tool ? '' : toolView.resultStatus(item, !!call, style)
	let key = look.call?.key ?? call
	if (!tool && key && transcript.addressable(key) && width >= 4 * strings.visLen(`↑ t${key}`)) {
		let ref = session && transcript.href(session, `t${key}`)
		let text = `↑ t${key}`
		let link = ansi.quiet(ref ? `\x1b]8;;${ansi.webUrl(ref)}\x07${text}${ansi.LINK_OFF}` : text, style)
		status = status ? `${status} ${link}` : link
	}
	let res = shown.map((l, i) => {
		let prefix = !i && item.isError ? '✗ ' : ''
		// Apart from its call, a result is its own block: it leads with its time.
		if (!i && !tool) prefix = titles.stamp(item.ts, prefix)
		let text = strings.clipVisual(prefix + l, width)
		let line = painted ? diffView.paint(text, tones[i]!, style) : tool || look.call ? text : ansi.quiet(text, style)
		return !i && status ? itemView.right(line, status, width) : line
	})
	if (more) {
		let marker = ansi.quiet(`… ${more} more lines${fold === 'long' ? ` in ${toolView.fullAt(item.output, session, (item as Partial<Keyed>).key)}` : ''}`, style)
		let last = res.at(-1)!
		if (strings.visLen(last) + 2 + strings.visLen(marker) <= width) res[res.length - 1] = itemView.right(last, marker, width)
		else res.push(marker)
	}
	return res
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
	return ansi.sgr({ fg: text === 'exit 1' ? colors.exit().neutralFg! : colors.exit().fg! }) + text + (style?.fg ? ansi.sgr({ fg: style.fg }) : '\x1b[39m')
}

// The status after a tool card's title (task wm0), quiet: a nonzero
// exit in the exit color, then the output's `lines` when the card hides
// them all, then the time, out of `limit` when the call has one
// (1.4s / 900s); '' with none of them.
function status(exit: string | undefined, time: string | undefined, style: Style | undefined, limit?: string, lines = 0): string {
	if (limit && time !== '') time = `${time ?? '0s'} / ${limit}`
	let rest = [lines ? `${lines} line${lines === 1 ? '' : 's'}` : '', time].filter(Boolean).join(', ')
	if (!exit && !rest) return ''
	if (!exit) return ansi.quiet(`(${rest})`, style)
	return ansi.quiet('(', style) + toolView.exitColor(exit, style) + ansi.quiet(rest ? `, ${rest})` : ')', style)
}

// A finished call's status from its result; `bash`: a bash call's.
// Steering's "(canceled)" or "(stopped, 50.2s)" is quiet: no failure.
// `hidden`: its card shows no output, so the status counts its lines.
function resultStatus(item: { output: string; diff?: string; ms?: number; isError?: boolean; interrupted?: 'canceled' | 'stopped' }, bash: boolean, style: Style | undefined, limit?: string, hidden = false): string {
	let text = bashResult.interrupted(item)
	if (text) return ansi.quiet(`(${text})`, style)
	if (item.diff && !item.isError) return diffView.status(item.diff, style, bashResult.duration(item.ms))
	let out = hidden ? (bash ? bashResult.display(item.output) : bashResult.trim(item.output)).replace(/\n$/, '') : ''
	return toolView.status(bashResult.failure(item, bash), bashResult.duration(item.ms), style, limit, out ? out.split('\n').length : 0)
}

// Where an open result's whole output is: the file its cut note names,
// else its line in the session's history file.
function fullAt(output: string, session: string | undefined, key = ''): string {
	let cut = /cat (\S+)\]\s*$/.exec(output)?.[1]
	if (cut) return cut
	let path = `${toolView.home}/sessions/${session ?? '?'}/history.asonl`
	if (process.env.HOME && path.startsWith(process.env.HOME + '/')) path = '~' + path.slice(process.env.HOME.length)
	return `${path} line ${/^\d+/.exec(key)?.[0] ?? '?'}`
}

export const toolView = {
	// Rows of an open result before its cut marker.
	openRows: 200,
	// A short call's rows before its output, for its result (frame.ts).
	heads: new WeakMap<object, number>(),
	// The Hal home for paths shown; main.ts sets hal --home.
	home: resolve(import.meta.dir, '../..'),
	call,
	result,
	unsafe,
	exitColor,
	status,
	resultStatus,
	fullAt,
}
