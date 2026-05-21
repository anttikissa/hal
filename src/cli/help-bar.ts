// Static context-sensitive help for the bottom help line.

type HelpState = 'idle-empty' | 'idle-text' | 'idle-continue' | 'idle-retry' | 'streaming' | 'streaming-text'

type ContinueAction = 'continue' | 'retry'

interface Hint {
	// Render as "key: description" when keyLabel/description are set. Free-text
	// hints are for state affordances that should read as a sentence.
	keyLabel?: string
	description?: string
	text?: string
}

interface HelpStyle {
	key: string
	description: string
	separator: string
}

const config = {
	rightKeyLabel: '/keys',
	rightDescription: 'shortcuts',
}

const HINTS: Record<HelpState, Hint[]> = {
	'idle-empty': [
		{ keyLabel: 'ctrl+t', description: 'new' },
		{ keyLabel: 'ctrl+n/p', description: 'switch' },
		{ keyLabel: 'ctrl+f', description: 'fork' },
		{ keyLabel: 'ctrl+c', description: 'quit' },
		{ keyLabel: 'ctrl+z', description: 'suspend' },
	],
	'idle-text': [
		{ keyLabel: 'enter', description: 'send' },
		{ keyLabel: 'shift+enter', description: 'newline' },
		{ keyLabel: 'alt+enter', description: 'queue' },
	],
	'idle-continue': [{ text: 'press enter to continue' }],
	'idle-retry': [{ text: 'press enter to retry' }],
	streaming: [{ keyLabel: 'esc', description: 'stop' }],
	'streaming-text': [
		{ keyLabel: 'enter', description: 'steer' },
		{ keyLabel: 'shift+enter', description: 'newline' },
		{ keyLabel: 'alt+enter', description: 'queue' },
		{ keyLabel: 'esc', description: 'stop' },
	],
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
	if (hint.text) {
		if (!style) return hint.text
		return `${style.description}${hint.text}`
	}
	if (!hint.keyLabel || !hint.description) return ''
	if (!style) return `${hint.keyLabel}: ${hint.description}`
	return `${style.key}${hint.keyLabel}${style.description}: ${hint.description}`
}

function shortcutListHint(style?: HelpStyle): string {
	return formatHint({ keyLabel: config.rightKeyLabel, description: config.rightDescription }, style)
}

function build(busy: boolean, hasText: boolean, continueAction: ContinueAction | false = false, style?: HelpStyle): string {
	const state = deriveState(busy, hasText, continueAction)
	const separator = style ? `${style.separator}, ${style.description}` : ', '
	return HINTS[state].map((hint) => formatHint(hint, style)).filter(Boolean).join(separator)
}

export const helpBar = {
	config,
	build,
	shortcutListHint,
	deriveState,
	HINTS,
}
