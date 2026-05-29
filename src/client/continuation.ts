import type { Block } from '../cli/blocks.ts'

export type ContinueAction = 'continue' | 'retry'

function isMaxIterationsStop(text: string | undefined): boolean {
	return /^Hit max iterations \(\d+\)\. Stopping\.$/.test(text ?? '')
}

function actionForBlock(block: Block): ContinueAction | false {
	if (block.type === 'error') {
		if ((block as any).retryable === false) return false
		if (isMaxIterationsStop(block.text)) return 'continue'
		return 'retry'
	}
	if (block.type === 'log' && (block.text === '[paused]' || block.text?.startsWith('[interrupted]'))) return 'continue'
	return false
}

function actionForTab(tab: any, working: boolean): ContinueAction | false {
	if (!tab) return false
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]!
		if (block.type === 'tool') {
			if (working) return false
			continue
		}
		if ((block.type === 'log' || block.type === 'info') && !actionForBlock(block)) {
			if (working) return false
			continue
		}
		return actionForBlock(block)
	}
	return false
}

export const continuation = { actionForTab }
