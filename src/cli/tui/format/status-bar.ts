const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

export function buildStatusBarLine(
	cols: number,
	tabsText: string,
	rightText: string,
	scrollOffset: number,
): string {
	const cleanTabs = tabsText.trimEnd()
	const cleanRight = rightText.trim()
	let line = ''
	if (cleanTabs) line += cleanTabs
	if (scrollOffset > 0) line += `${line ? '  ' : ''}↑${scrollOffset}`
	if (cleanRight) line += `${line ? '  ' : ''}${cleanRight}`
	if (line.length < cols) line += ' '.repeat(cols - line.length)
	return `${DIM}${line.slice(0, cols)}${RESET}`
}
