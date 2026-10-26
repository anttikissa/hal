// Draws the shared semantic diff tones (common/diff.ts) in the terminal
// (task k8y).
import { colors, type Style } from '../common/colors.ts'
import { diff, type DiffTone } from '../common/diff.ts'
import { ansi } from './ansi.ts'

function paint(text: string, tone: DiffTone | 'head', style?: Style, strike = false): string {
	if (tone === 'head' || ansi.mono()) return text
	if (tone === 'dim') return ansi.quiet(text, style)
	let d = colors.diff()
	let fg = { add: d.addFg, del: d.removeFg, add2: d.add2Fg, del2: d.remove2Fg }[tone]!
	return (
		ansi.sgr({ fg }) +
		(strike && tone === 'del' ? `\x1b[9m${text}\x1b[29m` : text) +
		(style?.fg ? ansi.sgr({ fg: style.fg }) : '\x1b[39m')
	)
}

// An EDIT card's status after its title: "(+3 −2, lines 25–27, 1.2s)".
function status(text: string, style?: Style, time?: string): string {
	let s = diff.stats(text)
	let counts = [
		s.added ? diffView.paint(`+${s.added}`, 'add', style) : '',
		s.removed ? diffView.paint(`−${s.removed}`, 'del', style) : '',
	]
		.filter(Boolean)
		.join(' ')
	return ansi.quiet('(', style) + counts + ansi.quiet(`, ${s.lines}${time ? `, ${time}` : ''})`, style)
}
export const diffView = { paint, status }
