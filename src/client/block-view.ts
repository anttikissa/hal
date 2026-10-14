// How much of a block the terminal shows (task hyt): a short block's
// first rows, and the spinner of a live title row. Pure.

import type { Style } from '../common/colors.ts'
import { settings } from '../common/settings.ts'
import { ansi } from './ansi.ts'
import { itemView } from './item-view.ts'

// A dot circling its cell: one frame per pulse beat (pulse.ts).
const spinner = [...'⠁⠈⠐⠠⢀⡀⠄⠂']
const toolSpinner = [...'⣀⡠⠤⠢⠒⠊⠉⠉⠑⠒⠔⠤⢄⣀⣀⢄⠤⠔⠒⠑⠉⠉⠊⠒⠢⠤⡠⣀']

// The spinner's frame at `beat`.
function spin(beat: number, tool = false): string {
	let frames = tool ? toolSpinner : blockView.spinner
	return frames[beat % frames.length]!
}

// The first `n` rows of `body`, or while it streams its last: its
// height grows to `n` and stays there. Done, the last row says how
// many rows follow, at its right.
function short(body: string[], width: number, streaming: boolean, style: Style | undefined, n = settings.shortRows()): string[] {
	if (body.length <= n) return body
	if (streaming) return body.slice(-n)
	let shown = body.slice(0, n)
	shown[n - 1] = itemView.right(shown[n - 1]!, ansi.quiet(`… ${body.length - n} more lines`, style), width)
	return shown
}
export const blockView = { spinner, spin, short }
