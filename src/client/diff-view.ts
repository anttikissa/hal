// Terminal rendering of shared semantic diff tones (task k8y).
import { colors, type Style } from '../common/colors.ts'
import type { DiffTone } from '../common/diff.ts'
import { ansi } from './ansi.ts'

function paint(text: string, tone: DiffTone | 'head', style?: Style, strike = false): string {
	if (tone === 'head' || ansi.mono()) return text
	if (tone === 'dim') return ansi.quiet(text, style)
	let fg = tone === 'add' ? colors.diff().addFg! : colors.diff().removeFg!
	return ansi.sgr({ fg }) + (strike && tone === 'del' ? `\x1b[9m${text}\x1b[29m` : text) + (style?.fg ? ansi.sgr({ fg: style.fg }) : '\x1b[39m')
}
export const diffView = { paint }
