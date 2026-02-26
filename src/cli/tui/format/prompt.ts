import { getStyle } from '../../format/theme.ts'
import { wrapPlainTextWithPadding } from './horizontal-padding.ts'

const RESET = '\x1b[0m'

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
		blockStart: `\n${bar}\x1b[K${RESET}\n`,
		blockEnd: `${bar}\x1b[K${RESET}\n`,
		formatText(text: string): string {
			return wrapPlainTextWithPadding(text, cols, PROMPT_SIDE_PADDING)
				.map((line) => `${bar}${textStyle}${line}\x1b[K${RESET}`)
				.join('\n')
		},
	}
}
