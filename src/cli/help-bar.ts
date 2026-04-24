// Show a small set of hints until the user has used those keys often enough.

type HelpState = 'idle-empty' | 'idle-text' | 'idle-continue' | 'streaming'

interface Hint {
	text: string
	keys: string[]
	// Some hints are state, not education. If Enter continues a paused/error
	// turn, the affordance must stay visible even after the key is learned.
	alwaysVisible?: boolean
}

const config = {
	learnThreshold: 5,
}

// Kept in memory for now; hints reset each launch.
const usageCounts: Record<string, number> = {}

const HINTS: Record<HelpState, Hint[]> = {
	'idle-empty': [
		{ text: 'ctrl-t new', keys: ['ctrl-t'] },
		{ text: 'ctrl-n/p switch', keys: ['ctrl-n', 'ctrl-p'] },
		{ text: 'ctrl-f fork', keys: ['ctrl-f'] },
		{ text: '/ commands', keys: ['/'] },
		{ text: 'ctrl-c quit', keys: ['ctrl-c'] },
		{ text: 'ctrl-z suspend', keys: ['ctrl-z'] },
	],
	'idle-text': [
		{ text: 'enter send', keys: ['enter'] },
		{ text: 'shift-enter newline', keys: ['shift-enter'] },
		{ text: 'tab complete', keys: ['tab'] },
	],
	'idle-continue': [{ text: 'press enter to continue', keys: ['enter'], alwaysVisible: true }],
	streaming: [{ text: 'esc stop', keys: ['escape'] }],
}

function isLearned(hint: Hint): boolean {
	if (hint.alwaysVisible) return false
	if (hint.keys.length === 0) return false
	return hint.keys.every((key) => (usageCounts[key] ?? 0) >= config.learnThreshold)
}

function logKey(name: string): void {
	usageCounts[name] = (usageCounts[name] ?? 0) + 1
}

function reset(): void {
	for (const key of Object.keys(usageCounts)) delete usageCounts[key]
}

function deriveState(busy: boolean, hasText: boolean, canContinue = false): HelpState {
	if (busy) return 'streaming'
	if (hasText) return 'idle-text'
	if (canContinue) return 'idle-continue'
	return 'idle-empty'
}

function build(busy: boolean, hasText: boolean, canContinue = false): string {
	const state = deriveState(busy, hasText, canContinue)
	const visible = HINTS[state].filter((hint) => !isLearned(hint))
	if (visible.length === 0) return ''
	return visible.map((hint) => hint.text).join(' \u2502 ')
}

export const helpBar = {
	config,
	build,
	logKey,
	reset,
	deriveState,
	isLearned,
	HINTS,
}
