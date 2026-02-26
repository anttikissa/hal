import { stripAnsi } from '../../format/index.ts'

const RESET = '\x1b[0m'

function visibleLength(text: string): number {
	return stripAnsi(text).length
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
		const plainLeft = stripAnsi(left)
		leftPart = plainLeft.slice(Math.max(0, plainLeft.length - maxLeftLen))
	}
	const gapLen = Math.max(2, cols - visibleLength(leftPart) - rightLen)
	const line = `${leftPart}${' '.repeat(gapLen)}${cleanRight}`
	return `${line}${RESET}`
