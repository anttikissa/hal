// The key hints for a session's state (task h67). The terminal's help
// row and the web composer's draw this one list, each in its own
// colors, as 'key: description, …' with keys named as in /keys.

import { sendKeys } from './send-keys.ts'
import { states, type SessionState } from './states.ts'

export type Hint = [key: string, description: string]

// A slash command being typed (bare / too), not an absolute file path.
// Commands run at once and never queue (task 7t).
const commandDraft = (text: string) => /^\/(?:[a-z][a-z0-9-]*(?:\s|$)|$)/.test(text.trim())

// The hints for `state` with `text` in the prompt.
function keys(state: SessionState | undefined, text: string): Hint[] {
	let working = !!state && states.busy(state)
	let typed = text.trim() !== ''
	if (typed && commandDraft(text)) return [['enter', 'run'], ['shift-enter', 'newline'], ...(working ? [['esc', 'pause'] as Hint] : [])]
	if (working && typed) return [...sendKeys.hints(true), ['shift-enter', 'newline'], ['esc', 'pause']]
	if (state?.type === 'retrying') return [['enter', 'retry now'], ['esc', 'pause']]
	if (working) return [['esc', 'pause']]
	if (typed) {
		let h = sendKeys.hints(false)
		return [...h.filter((x) => x[1] === 'send'), ['shift-enter', 'newline'], ...h.filter((x) => x[1] === 'queue')]
	}
	if (state?.type === 'paused') return [['enter', 'continue']]
	if (state?.type === 'error') return [['enter', 'retry']]
	return []
}

export const hints = { commandDraft, keys }
