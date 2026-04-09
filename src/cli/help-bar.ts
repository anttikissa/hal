// Context-sensitive help bar — shows keybinding hints based on app state.
// Ported and simplified from prev/src/cli/help-bar.ts.
//
// The bar auto-hides hints after the user has used the associated keys
// enough times (tracked via usage counts). This keeps the UI clean for
// experienced users while guiding newcomers.

// ── Types ────────────────────────────────────────────────────────────────────

type HelpState = 'idle-empty' | 'idle-text' | 'streaming'

interface Hint {
	text: string
	// Usage count key names. All must reach threshold to hide this hint.
	keys: string[]
}

// ── Config ───────────────────────────────────────────────────────────────────

const config = {
	// How many times a key combo must be used before its hint disappears.
	learnThreshold: 5,
}

// ── State ────────────────────────────────────────────────────────────────────

// Usage counts: keyed by canonical key name (e.g. "ctrl-t", "enter").
// This is a simple in-memory map — persistence could be added later via
// liveFile, but for now we just show hints every session.
const usageCounts: Record<string, number> = {}

// ── Hint definitions per state ───────────────────────────────────────────────

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
	streaming: [{ text: 'esc stop', keys: ['escape'] }],
}

// ── Logic ────────────────────────────────────────────────────────────────────

function isLearned(hint: Hint): boolean {
	if (hint.keys.length === 0) return false
	return hint.keys.every((k) => (usageCounts[k] ?? 0) >= config.learnThreshold)
}

function logKey(name: string): void {
	usageCounts[name] = (usageCounts[name] ?? 0) + 1
}

function reset(): void {
	for (const key of Object.keys(usageCounts)) delete usageCounts[key]
}

function deriveState(busy: boolean, hasText: boolean): HelpState {
	if (busy) return 'streaming'
	if (hasText) return 'idle-text'
	return 'idle-empty'
}

// Build the help bar string. Returns empty string if all hints are learned.
function build(busy: boolean, hasText: boolean): string {
	const st = deriveState(busy, hasText)
	const visible = HINTS[st].filter((h) => !isLearned(h))
	if (visible.length === 0) return ''
	return visible.map((h) => h.text).join(' \u2502 ')
}

// ── Namespace ────────────────────────────────────────────────────────────────

export const helpBar = {
	config,
	build,
	logKey,
	reset,
	deriveState,
	isLearned,
	HINTS,
}
