import { blocks, type Block } from './blocks.ts'

export interface HeightTab {
	sessionId: string
	blocks: Block[]
	contentHeight: number
}

export function maxTabHeight(
	tabs: HeightTab[],
	activeSessionId: string | null,
	width: number,
	activeHeight: number,
): number {
	let maxHeight = 0
	for (const tab of tabs) {
		if (tab.sessionId === activeSessionId) {
			tab.contentHeight = Math.max(tab.contentHeight, activeHeight)
		} else if (tab.contentHeight === 0 && tab.blocks.length > 0) {
			tab.contentHeight = blocks.renderBlocks(tab.blocks, width, false).lines.length
		}
		if (tab.contentHeight > maxHeight) maxHeight = tab.contentHeight
	}
	return maxHeight
}

export const heights = { maxTabHeight }
