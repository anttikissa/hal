import { stripAnsi } from '../../format/index.ts'

const RESET = '\x1b[0m'
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

function visibleLength(text: string): number {
	return stripAnsi(text).length
}

/** Truncate `text` from the left to at most `maxVisible` visible characters, preserving ANSI escapes. */
function truncateLeftAnsi(text: string, maxVisible: number): string {
	const totalVisible = visibleLength(text)
	if (totalVisible <= maxVisible) return text
	const dropCount = totalVisible - maxVisible
	// Walk through the string, skipping ANSI sequences, counting visible chars to drop
	let dropped = 0
	let i = 0
	while (i < text.length && dropped < dropCount) {
		ANSI_RE.lastIndex = i
		const m = ANSI_RE.exec(text)
		if (m && m.index === i) {
			// Skip over ANSI escape — don't count it as a visible character
			i += m[0].length
		} else {
			dropped++
			i++
		}
	}
	return RESET + text.slice(i)
}

export function buildStatusBarLine(
	cols: number,
	tabsText: string,
	rightText: string,
	scrollOffset: number,
): string {
	const cleanTabs = tabsText.trimEnd()
	const cleanRight = rightText.trim()
	const leftParts: string[] = []
	if (cleanTabs) leftParts.push(cleanTabs)
	if (scrollOffset > 0) leftParts.push(`↑${scrollOffset}`)
	const left = leftParts.join('  ')
	if (!cleanRight) {
		const line = left + ' '.repeat(Math.max(0, cols - visibleLength(left)))
		return `${line}${RESET}`
	}

	const rightLen = visibleLength(cleanRight)
	if (rightLen >= cols) {
		return `${stripAnsi(cleanRight).slice(0, cols)}${RESET}`
	}
	const maxLeftLen = Math.max(0, cols - rightLen - 2)
	const leftLen = visibleLength(left)
	let leftPart = left
	if (leftLen > maxLeftLen) {
		leftPart = truncateLeftAnsi(left, maxLeftLen)
	}
	const gapLen = Math.max(2, cols - visibleLength(leftPart) - rightLen)
	const line = `${leftPart}${' '.repeat(gapLen)}${cleanRight}`
	return `${line}${RESET}`
}