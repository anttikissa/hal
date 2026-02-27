import { getStyle } from '../../format/theme.ts'
import { wrapPlainTextWithPadding } from './horizontal-padding.ts'

const RESET = '\x1b[0m'
const CLEAR_EOL = '\x1b[K'

const PROMPT_SIDE_PADDING = { left: 1, right: 1 }

export interface PromptBlockFormatter {
	blockStart: string
	blockEnd: string
	formatText(text: string): string
}

export function buildPromptBlockFormatter(cols: number): PromptBlockFormatter {
	const bar = getStyle('prompt.bar')
	const textStyle = getStyle('prompt.text')
	return {
		blockStart: `\n${bar}${CLEAR_EOL}${RESET}\n`,
		blockEnd: `${bar}${CLEAR_EOL}${RESET}\n`,
		formatText(text: string): string {
			return wrapPlainTextWithPadding(text, cols, PROMPT_SIDE_PADDING)
				.map((line) => `${bar}${textStyle}${line}${CLEAR_EOL}${RESET}`)
				.join('\n')
		},
	}
}
