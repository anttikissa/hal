import type { Formatter } from './types.ts'
import { BOLD, BG_GREY, RESET } from './ansi.ts'

export default {
	style: BOLD,
	blockStart(cols: number): string {
		return `\n${BG_GREY}${' '.repeat(cols)}${RESET}\n`
	},
	blockEnd(cols: number): string {
		return `${BG_GREY}${' '.repeat(cols)}${RESET}\n`
	},
} satisfies Formatter
