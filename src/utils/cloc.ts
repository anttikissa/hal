// Non-comment, non-blank line counting shared by bun cloc and commit summaries.

interface CountState {
	inBlock: boolean
}

function countLine(line: string, state: CountState): number {
	const t = line.trim()
	if (state.inBlock) {
		if (t.includes('*/')) state.inBlock = false
		return 0
	}
	if (!t || t.startsWith('//')) return 0
	if (t.startsWith('/*')) {
		if (!t.includes('*/')) state.inBlock = true
		return 0
	}
	return 1
}

function countText(text: string): number {
	const state = { inBlock: false }
	let lines = 0
	for (const line of text.split('\n')) lines += countLine(line, state)
	return lines
}

export const cloc = { countLine, countText }
