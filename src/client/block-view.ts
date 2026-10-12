// How much of a block the terminal shows (task hyt): a glimpse of a
// body, the end of streaming text on a short row, and the spinner of a
// live title row. Pure.

import type { Style } from '../common/colors.ts'
import { settings } from '../common/settings.ts'
import { strings } from '../common/strings.ts'
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
function glimpse(body: string[], width: number, streaming: boolean, style: Style | undefined, n = settings.glimpseRows()): string[] {
	if (body.length <= n) return body
	if (streaming) return body.slice(-n)
	let shown = body.slice(0, n)
	shown[n - 1] = itemView.right(shown[n - 1]!, ansi.quiet(`… ${body.length - n} more lines`, style), width)
	return shown
}

// The end of `text` in at most `width` columns, on one line: '…' and
// its last words.
function tail(text: string, width: number): string {
	let s = text.slice(-width * 4).replace(/\s+/g, ' ').trim()
	if (strings.visLen(s) <= width) return s
	let chars = [...s]
	let cols = 1, i = chars.length
	while (i > 0 && cols + strings.visLen(chars[i - 1]!) <= width) cols += strings.visLen(chars[--i]!)
	let rest = chars.slice(i).join('')
	// Cut inside a word or after a stop, it starts at the next word.
	let word = rest.search(/(?<=\s)\S/)
	return '…' + (word > 0 && !/^\s/.test(chars[i - 1] ?? '') ? rest.slice(word) : rest.trimStart())
}

export const blockView = { spinner, spin, glimpse, tail }
