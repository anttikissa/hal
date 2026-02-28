import { getStyle } from '../../format/theme.ts'
import { wrapPlainTextWithPadding } from './horizontal-padding.ts'

const RESET = '\x1b[0m'
const CLEAR_EOL = '\x1b[K'

const BLOCK_SIDE_PADDING = { left: 1, right: 1 }

export interface BlockFormatter {
	blockStart: string
	blockEnd: string
	formatText(text: string): string
}

export function buildBlockFormatter(cols: number, bar: string, textStyle: string): BlockFormatter {
	return {
		blockStart: `\n${bar}${CLEAR_EOL}${RESET}\n`,
		blockEnd: `${bar}${CLEAR_EOL}${RESET}\n`,
		formatText(text: string): string {
			return wrapPlainTextWithPadding(text, cols, BLOCK_SIDE_PADDING)
				.map((line) => `${bar}${textStyle}${line}${CLEAR_EOL}${RESET}`)
				.join('\n')
		},
	}
}

export function buildPromptBlockFormatter(cols: number, steering = false): BlockFormatter {
	return buildBlockFormatter(
		cols,
		getStyle(steering ? 'prompt.steering.bar' : 'prompt.bar'),
		getStyle(steering ? 'prompt.steering.text' : 'prompt.text'),
	)
}
