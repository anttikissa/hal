import { bashResult } from './bash-result.ts'
import { summary } from './summary.ts'
import type { Shown } from './transcript.ts'
import type { Fold } from './toggle.ts'

function toggles(item: Shown): boolean {
	return item.type === 'tool' || item.type === 'thinking' || item.type === 'text' || item.type === 'prompt' || (item.type === 'output' && !!item.change)
}

function initial(item: Shown): Fold {
	return item.type === 'thinking' || item.type === 'tool' || (item.type === 'output' && !!item.change) || (item.type === 'prompt' && (!!item.summary || !!bashResult.background(item) || !!item.waiting && item.delivery === 'after-turn')) ? 'closed' : 'open'
}

function text(item: Shown & { type: 'prompt' | 'text' | 'thinking' }): string {
	if (item.type === 'text') return summary.answer(item.text)
	if (item.type === 'thinking') return item.text
	return bashResult.background(item) ? bashResult.display(item.text) : item.report ? summary.answer(item.text) : item.summary ? summary.strip(item.text) : item.text
}

function markdown(item: Shown): boolean {
	return item.type === 'text' || item.type === 'thinking' || item.type === 'output' || (item.type === 'prompt' && !!item.from && !bashResult.background(item))
}

export const card = { toggles, initial, text, markdown }
