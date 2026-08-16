import type { Block } from './block-data.ts'

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
	if (block.type === 'log' && (block.text === '[paused]' || block.text === '[paused before local tools]' || block.text?.startsWith('[interrupted]'))) return 'continue'
	return false
}

function actionForTab(tab: any, working: boolean): ContinueAction | false {
	if (!tab) return false
	if (working) return false
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]!
		if (block.type === 'tool') continue
		const action = actionForBlock(block)
		if (action) return action
		// No action here. Logs, info, and non-retryable command errors (e.g. a
		// "/login: Usage" typo) are incidental activity, not turn outcomes — skip
		// them so a fixed login can still resume the failed turn behind them.
		if (block.type === 'log' || block.type === 'info' || (block.type === 'error' && (block as any).retryable === false)) continue
		return false
	}
	return false
}

export const continuation = { actionForTab }
