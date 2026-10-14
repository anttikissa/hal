import { toolPresentation, type ToolPresentation } from '../common/tool-presentation.ts'
import { diff } from '../common/diff.ts'
import type { Shown as Item } from '../common/transcript.ts'
import type { Verbosity } from '../common/card.ts'
import type { Style } from '../common/colors.ts'
import { ansi } from './ansi.ts'
import { diffView } from './diff-view.ts'

function lines(presentation: ToolPresentation, output: string, width: number, style: Style | undefined): string[] {
	return presentation.blocks.flatMap((b, i) => [
		...(i ? [''] : []),
		...(b.path ? ansi.wrap(ansi.clean(b.path), width) : []),
		...toolPresentation.text(b, output).split('\n').flatMap((line) => ansi.wrap(ansi.clean(line), width).map((r) => b.kind === 'diff' ? diffView.paint(r, diff.tone(line), style) : r)),
	])
}

function call(item: Item & { type: 'tool' }, head: string, width: number, fold: Verbosity, result: Item | undefined, style: Style | undefined): string[] {
	let rows = [head]
	if (item.presentationError) rows.push(...ansi.wrap(ansi.clean(item.presentationError), width))
	if (fold === 'long' && !result && item.presentation) rows.push(...presentationView.lines(item.presentation, '', width, style))
	return rows
}

export const presentationView = { lines, call }
