// Tool calls and their results as the terminal draws them (tasks wm0,
// ghs, 4y4, hyt): short is the title row (and a running call's latest
// output line), glimpse adds the command and a few output rows, long
// all of them. Pure.

import { bashResult } from '../common/bash-result.ts'
import { colors, type Style } from '../common/colors.ts'
import { diff } from '../common/diff.ts'
import { settings } from '../common/settings.ts'
import { strings } from '../common/strings.ts'
import type { Fold } from '../common/toggle.ts'
import { titles } from '../common/titles.ts'
import { toolDetails } from '../common/tool-details.ts'
import { transcript, type Item as Keyed, type Shown as Item } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { diffView } from './diff-view.ts'
import { itemView, type Look } from './item-view.ts'
import { presentationView } from './tool-presentation.ts'
import { resolve } from 'path'

const open = (fold: Fold) => fold === 'long' || fold === 'inline'

// A call's rows. Its result's status and the activity cell sit at the
// right of the first row (frame.ref), which look.headerWidth leaves.
function call(item: Item & { type: 'tool' }, width: number, fold: Fold, look: Look): string[] {
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
	if (open(fold)) {
		let rows = ansi.wrap(prefix + title, hw)
		rows[0] = toolView.unsafe(rows[0]!, item, hw)
		return [...rows, ...toolDetails.lines(item.name, item.input).flatMap((line) => ansi.wrap(ansi.clean(line), width)), ...(item.partial ? ['', ...ansi.wrap(ansi.clean(item.partial.replace(/\n$/, '')), width)] : [])]
	}
	// Short: running, its latest output line follows the title.
	if (fold === 'short') {
		let last = item.partial?.split('\n').findLast((l) => l.trim())
		return [last ? toolView.unsafe(strings.expandTabs(strings.clipVisual(`${prefix}${title}  ${ansi.quiet(ansi.clean(last.trim()), itemView.itemStyle(item))}`, hw)), item, hw) : head]
	}
	// Running output is laid out as its result glimpse will be (a blank
	// row, then the glimpse rows), so the card keeps its height when the
	// call finishes (task 4y4).
	let n = settings.glimpseRows()
	let live = item.partial ? item.partial.replace(/\n$/, '').split('\n').slice(-n).flatMap((line) => ansi.wrap(ansi.clean(line), width, false)).slice(-n) : []
	if (!bash) return [head, ...live]
	let details = toolDetails.lines(item.name, item.input)
	let commandRows = typeof command === 'string' ? command.split('\n').length : 0
	let preview = commandRows ? [strings.expandTabs(strings.clipVisual(ansi.clean(details[0]!) + (commandRows > 1 ? '…' : ''), width))] : []
	return [head, ...preview, ...details.slice(commandRows).flatMap((line) => ansi.wrap(ansi.clean(line), width)), ...(live.length ? ['', ...live] : [])]
}

// A result's rows: `call` the id of the bash call it answers (its output
// is a bash display), `tool` the call's name when drawn under it. Short,
// an attached result draws nothing; apart, its header row stays, for
// its time, link and status.
function result(item: Item & { type: 'tool-result' }, width: number, fold: Fold, look: Look, session: string | undefined, call: string | undefined, tool: string | undefined): string[] {
	// A canceled call's note to the model: the title says "(canceled)".
	let out = item.interrupted === 'canceled' ? '' : call ? bashResult.display(item.output, !!item.interrupted) : bashResult.trim(item.output)
	let style = itemView.itemStyle(item, tool)
	if (tool && (fold === 'short' || (!out && !item.isError && !item.presentation && !item.presentationError))) return []
	if (tool && (item.presentation || item.presentationError) && open(fold)) return [...(item.presentationError ? ansi.wrap(ansi.clean(item.presentationError), width) : []), ...(fold === 'inline' || item.isError || !item.presentation ? ansi.wrap(ansi.clean(out), width) : presentationView.lines(item.presentation, item.output, width, style))]
	let max = look.full ? Infinity : open(fold) ? toolView.openRows : settings.glimpseRows()
	// An attached EDIT result shows its diff in diff colors.
	let painted = tool && item.diff, lines = (painted || out).split('\n'), tones: ReturnType<typeof diff.tone>[] = []
	let rows: string[] = [], used = 0
	while (used < lines.length && rows.length <= max) {
		let line = lines[used++]!, wrapped = ansi.wrap(line.slice(0, (max + 1) * width * 4), width, false)
		rows.push(...wrapped)
		tones.push(...wrapped.map(() => diff.tone(line)))
	}
	let shown = rows.slice(0, max)
	let more = rows.length - shown.length + lines.length - used
	let status = tool ? '' : toolView.resultStatus(item, !!call, style)
	let res = shown.map((l, i) => {
		let prefix = !i && item.isError ? '✗ ' : ''
		// Apart from its call, a result is its own block: it leads with its time.
		if (!i && !tool) prefix = titles.stamp(item.ts, prefix)
		let ref = !i && !tool && call && session && transcript.href(session, `t${call}`)
		if (ref) prefix += `\x1b]8;;${ansi.webUrl(ref)}\x07t${call}${ansi.LINK_OFF}> `
		let text = strings.clipVisual(prefix + l, width)
		let line = painted ? diffView.paint(text, tones[i]!, style) : tool ? text : ansi.quiet(text, style)
		return !i && status ? itemView.right(line, status, width) : line
	})
	if (more) {
		let marker = ansi.quiet(`… ${more} more lines${open(fold) ? ` in ${toolView.fullAt(item.output, session, (item as Partial<Keyed>).key)}` : ''}`, style)
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
	return ansi.sgr({ fg: colors.exit().fg! }) + text + (style?.fg ? ansi.sgr({ fg: style.fg }) : '\x1b[39m')
}

// The status after a tool card's title (task wm0), quiet: a nonzero
// exit in the exit color, then the time; '' with neither.
function status(exit: string | undefined, time: string | undefined, style: Style | undefined): string {
	if (!exit && !time) return ''
	if (!exit) return ansi.quiet(`(${time})`, style)
	return ansi.quiet('(', style) + toolView.exitColor(exit, style) + ansi.quiet(time ? `, ${time})` : ')', style)
}

// A finished call's status from its result; `bash`: a bash call's.
// Steering's "(canceled)" or "(stopped, 50.2s)" is quiet: no failure.
function resultStatus(item: { output: string; diff?: string; ms?: number; isError?: boolean; interrupted?: 'canceled' | 'stopped' }, bash: boolean, style: Style | undefined): string {
	let text = bashResult.interrupted(item)
	if (text) return ansi.quiet(`(${text})`, style)
	if (item.diff && !item.isError) return diffView.status(item.diff, style, bashResult.duration(item.ms))
	return toolView.status(bashResult.failure(item, bash), bashResult.duration(item.ms), style)
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

export const toolView = {
	// Rows of an open result before its cut marker.
	openRows: 200,
	call,
	result,
	unsafe,
	exitColor,
	status,
	resultStatus,
	fullAt,
}
