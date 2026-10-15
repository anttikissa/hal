// A plugin's tool presentation as terminal rows (tasks 0hy, sn7): the
// error once, then its blocks, then live output; short cards preview
// them in the short row budget, open ones end with where the raw call
// and result are.

import { toolPresentation, type ToolPresentation } from '../common/tool-presentation.ts'
import { diff } from '../common/diff.ts'
import type { Shown as Item } from '../common/transcript.ts'
import type { Verbosity } from '../common/card.ts'
import type { Style } from '../common/colors.ts'
import { settings } from '../common/settings.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'
import { diffView } from './diff-view.ts'

function lines(presentation: ToolPresentation, output: string, width: number, style: Style | undefined): string[] {
	return presentation.blocks.flatMap((b, i) => [
		...(i ? [''] : []),
		...(b.path ? ansi.wrap(ansi.clean(b.path), width) : []),
		...toolPresentation.text(b, output).split('\n').flatMap((line) => ansi.wrap(ansi.clean(line), width).map((r) => b.kind === 'diff' ? diffView.paint(r, diff.tone(line), style) : r)),
	])
}

// `rows` cut to `max`, the last one saying how many more there are.
function cut(rows: string[], max: number, width: number, style: Style | undefined): string[] {
	if (rows.length <= max) return rows
	if (max <= 0) return []
	let marker = ansi.quiet(`… ${rows.length - max + 1} more lines`, style)
	return [...rows.slice(0, max - 1), strings.clipVisual(marker, width)]
}

// A presented call before its result: its blocks, then live output.
// With a result, the result draws them under the title.
function call(item: Item & { type: 'tool' }, head: string, width: number, fold: Verbosity, result: Item | undefined, style: Style | undefined): string[] {
	let rows = [head, ...(item.presentationError ? ansi.wrap(ansi.clean(item.presentationError), width) : [])]
	if (result) return rows
	if (item.presentation) rows.push(...presentationView.lines(item.presentation, '', width, style))
	if (item.partial) rows.push(...ansi.wrap(ansi.clean(item.partial.replace(/\n$/, '')), width))
	return fold === 'long' ? rows : [head, ...presentationView.cut(rows.slice(1), settings.shortRows() - 1, width, style)]
}

// A presented result's rows: the complete error when it failed or
// stopped, then the blocks in normal output color (`normal`), then,
// open, where the raw call and result are (`raw`).
function result(item: Item & { type: 'tool-result' }, out: string, width: number, max: number, style: Style | undefined, normal: Style | undefined, raw: string | undefined): string[] {
	let rows = item.presentationError ? ansi.wrap(ansi.clean(item.presentationError), width) : []
	if (item.isError || item.interrupted || !item.presentation) rows.push(...ansi.wrap(ansi.clean((item.isError ? '✗ ' : '') + out), width))
	if (item.presentation) {
		let blocks = presentationView.lines(item.presentation, item.output, width, style)
		let back = style?.fg ? ansi.sgr({ fg: style.fg }) : '\x1b[39m'
		let color = item.isError && normal?.fg && !ansi.mono() ? (r: string) => ansi.sgr({ fg: normal.fg! }) + r + back : (r: string) => r
		rows.push(...blocks.map(color))
	}
	if (max === Infinity && raw) rows.push(ansi.quiet(strings.clipVisual(`Raw call and result: ${raw}`, width), item.isError ? normal : style))
	return presentationView.cut(rows, max, width, style)
}

export const presentationView = { lines, cut, call, result }
