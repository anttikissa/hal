// Terminal rendering of shared semantic diff tones (task k8y).
import { colors, type Style } from '../common/colors.ts'
import { diff, type DiffTone } from '../common/diff.ts'
import { ansi } from './ansi.ts'

function paint(text: string, tone: DiffTone | 'head', style?: Style, strike = false): string {
	if (tone === 'head' || ansi.mono()) return text
	if (tone === 'dim') return ansi.quiet(text, style)
	let fg = tone === 'add' ? colors.diff().addFg! : colors.diff().removeFg!
	return ansi.sgr({ fg }) + (strike && tone === 'del' ? `\x1b[9m${text}\x1b[29m` : text) + (style?.fg ? ansi.sgr({ fg: style.fg }) : '\x1b[39m')
}

// An EDIT card's status after its title: "(+3 −2, lines 25–27, 1.2s)".
function status(text: string, style?: Style, time?: string): string {
	let s = diff.stats(text)
	let counts = [s.added ? diffView.paint(`+${s.added}`, 'add', style) : '', s.removed ? diffView.paint(`−${s.removed}`, 'del', style) : ''].filter(Boolean).join(' ')
	return ansi.quiet('(', style) + counts + ansi.quiet(`, ${s.lines}${time ? `, ${time}` : ''})`, style)
}
export const diffView = { paint, status }
