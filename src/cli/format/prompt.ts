import type { Formatter } from './types.ts'
import { BOLD, BG_GREY, RESET } from './ansi.ts'

export default {
	style: BOLD,
	blockStart(cols: number): string {
		// Use cols-1 to match the word-wrap width, preventing grey bars from wrapping
		// and splitting BG_GREY from its RESET onto separate lines
		const w = Math.max(0, cols - 1)
		return `\n${BG_GREY}${' '.repeat(w)}${RESET}\n`
	},
	blockEnd(cols: number): string {
		const w = Math.max(0, cols - 1)
		return `${BG_GREY}${' '.repeat(w)}${RESET}\n`
	},
} satisfies Formatter
