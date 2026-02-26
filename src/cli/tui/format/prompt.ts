import { getStyle } from '../../format/theme.ts'

const RESET = '\x1b[0m'

export interface PromptBlockFormatter {
	lineStart: string
	lineEnd: string
	blockStart: string
	blockEnd: string
}

export function buildPromptBlockFormatter(cols: number): PromptBlockFormatter {
	const bar = getStyle('prompt.bar')
	const text = getStyle('prompt.text')
	const lineStart = `${bar}${text}`
	return {
		lineStart,
		lineEnd: RESET,
		blockStart: `\n${bar}\x1b[K${RESET}\n`,
		blockEnd: `${bar}\x1b[K${RESET}\n`,
	}
}
