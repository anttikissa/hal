import { toolPresentation, type ToolPresentation } from '../common/tool-presentation.ts'
import { diff } from '../common/diff.ts'
import { toolDetails } from '../common/tool-details.ts'
import type { Shown as Item } from '../common/transcript.ts'
import type { Fold } from '../common/toggle.ts'
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

function call(item: Item & { type: 'tool' }, head: string, width: number, fold: Fold | undefined, result: Item | undefined, style: Style | undefined): string[] {
	let rows = [head]
	if (item.presentationError) rows.push(...ansi.wrap(ansi.clean(item.presentationError), width))
	if (fold === 'inline') rows.push('Raw call', ...toolDetails.value(item.input).flatMap((r) => ansi.wrap(ansi.clean(r), width)))
	else if (fold === 'open') {
		if (!result && item.presentation) rows.push(...presentationView.lines(item.presentation, '', width, style))
		rows.push(...ansi.wrap('Toggle again for raw call and result', width))
	}
	return rows
}

export const presentationView = { lines, call }
