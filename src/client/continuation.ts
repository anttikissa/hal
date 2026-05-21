import type { Block } from '../cli/blocks.ts'

export type ContinueAction = 'continue' | 'retry'

function isMaxIterationsStop(text: string | undefined): boolean {
	return /^Hit max iterations \(\d+\)\. Stopping\.$/.test(text ?? '')
}

function actionForBlock(block: Block): ContinueAction | false {
	if (block.type === 'error') return isMaxIterationsStop(block.text) ? 'continue' : 'retry'
	if (block.type === 'log' && (block.text === '[paused]' || block.text?.startsWith('[interrupted]'))) return 'continue'
	return false
}

function actionForTab(tab: any, busy: boolean): ContinueAction | false {
	if (!tab) return false
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]!
		if (block.type === 'tool') {
			if (busy) return false
			continue
		}
		if ((block.type === 'log' || block.type === 'info') && !actionForBlock(block)) {
			if (busy) return false
			continue
		}
		return actionForBlock(block)
	}
	return false
}

export const continuation = { actionForTab }
