// Show a small set of hints until the user has used those keys often enough.

type HelpState = 'idle-empty' | 'idle-text' | 'idle-continue' | 'idle-retry' | 'streaming' | 'streaming-text'

type ContinueAction = 'continue' | 'retry'

interface Hint {
	// Render as "key: description". Keeping the parts separate lets the
	// terminal renderer make keys brighter than explanatory text.
	keyLabel: string
	description: string
	keys: string[]
	// Some hints are state, not education. If Enter continues/retries a
	// paused/error turn, the affordance must stay visible even after learned.
	alwaysVisible?: boolean
}

interface HelpStyle {
	key: string
	description: string
	separator: string
}

const config = {
	learnThreshold: 5,
	rightKeyLabel: '/keys',
	rightDescription: 'shortcuts',
}

// Kept in memory for now; hints reset each launch.
const usageCounts: Record<string, number> = {}

const HINTS: Record<HelpState, Hint[]> = {
	'idle-empty': [
		{ keyLabel: 'ctrl+t', description: 'new', keys: ['ctrl-t'] },
		{ keyLabel: 'ctrl+n/p', description: 'switch', keys: ['ctrl-n', 'ctrl-p'] },
		{ keyLabel: 'ctrl+f', description: 'fork', keys: ['ctrl-f'] },
		{ keyLabel: 'ctrl+c', description: 'quit', keys: ['ctrl-c'] },
		{ keyLabel: 'ctrl+z', description: 'suspend', keys: ['ctrl-z'] },
	],
	'idle-text': [
		{ keyLabel: 'enter', description: 'send', keys: ['enter'] },
		{ keyLabel: 'shift+enter', description: 'newline', keys: ['shift-enter'] },
		{ keyLabel: 'alt+enter', description: 'queue', keys: ['alt-enter'] },
	],
	'idle-continue': [{ keyLabel: 'enter', description: 'continue', keys: ['enter'], alwaysVisible: true }],
	'idle-retry': [{ keyLabel: 'enter', description: 'retry', keys: ['enter'], alwaysVisible: true }],
	streaming: [{ keyLabel: 'esc', description: 'stop', keys: ['escape'] }],
	'streaming-text': [
		{ keyLabel: 'enter', description: 'steer', keys: ['enter'] },
		{ keyLabel: 'shift+enter', description: 'newline', keys: ['shift-enter'] },
		{ keyLabel: 'alt+enter', description: 'queue', keys: ['alt-enter'] },
		{ keyLabel: 'esc', description: 'stop', keys: ['escape'] },
	],
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

function deriveState(busy: boolean, hasText: boolean, continueAction: ContinueAction | false = false): HelpState {
	if (hasText) {
		if (busy) return 'streaming-text'
		return 'idle-text'
	}
	if (continueAction === 'retry') return 'idle-retry'
	if (continueAction === 'continue') return 'idle-continue'
	if (busy) return 'streaming'
	return 'idle-empty'
}

function formatHint(hint: Hint, style?: HelpStyle): string {
	if (!style) return `${hint.keyLabel}: ${hint.description}`
	return `${style.key}${hint.keyLabel}${style.description}: ${hint.description}`
}

function shortcutListHint(style?: HelpStyle): string {
	const hint: Hint = { keyLabel: config.rightKeyLabel, description: config.rightDescription, keys: [] }
	return formatHint(hint, style)
}

function build(busy: boolean, hasText: boolean, continueAction: ContinueAction | false = false, style?: HelpStyle): string {
	const state = deriveState(busy, hasText, continueAction)
	const visible = HINTS[state].filter((hint) => !isLearned(hint))
	if (visible.length === 0) return ''
	const separator = style ? `${style.separator}, ${style.description}` : ', '
	return visible.map((hint) => formatHint(hint, style)).join(separator)
}

export const helpBar = {
	config,
	build,
	shortcutListHint,
	logKey,
	reset,
	deriveState,
	isLearned,
	HINTS,
}
