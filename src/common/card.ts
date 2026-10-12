// Shared card decisions (tasks c5x, hyt): which blocks expand and
// collapse, how much of each shows at first, and their text.

import { bashResult } from './bash-result.ts'
import type { SessionMeta } from './session.ts'
import { settings } from './settings.ts'
import { summary } from './summary.ts'
import type { Shown } from './transcript.ts'
import type { Fold } from './toggle.ts'

// How much of a block shows (task hyt): its title row, a glimpse, or all.
export type Verbosity = 'short' | 'glimpse' | 'long'
// What config.ason and /blocks set a start state for.
export type Kind = 'prompt' | 'text' | 'thinking' | 'tool' | 'failed' | 'message' | 'notice'

const kinds: Kind[] = ['prompt', 'text', 'thinking', 'tool', 'failed', 'message', 'notice']
const levels: Verbosity[] = ['short', 'glimpse', 'long']

// Tool calls that carry a message to another session.
const messaging = new Set(['send', 'spawn'])

// `item`'s kind, or undefined if it never expands or collapses.
// `failed`: a tool call whose result is an error.
function kind(item: Shown, failed = false): Kind | undefined {
	switch (item.type) {
		case 'thinking':
		case 'text':
			return item.type
		case 'tool':
			return failed ? 'failed' : messaging.has(item.name) ? 'message' : 'tool'
		case 'output':
			return item.change ? 'notice' : undefined
		case 'prompt':
			if (bashResult.background(item) || (item.from === undefined && item.origin === 'model')) return 'notice'
			return item.from === undefined ? 'prompt' : 'message'
	}
	return undefined
}

function toggles(item: Shown): boolean {
	return card.kind(item) !== undefined
}

// The config.ason key of `kind`'s start state: blockVerbosityTool.
function setting(kind: Kind): string {
	return `blockVerbosity${kind[0]!.toUpperCase()}${kind.slice(1)}`
}

// How `kind` starts in a session with overrides `blocks`: its
// override, else this client's setting.
function verbosity(kind: Kind, blocks?: SessionMeta['blocks']): Verbosity {
	return blocks?.[kind] ?? (settings.value(card.setting(kind)) as Verbosity)
}

// Whether a call failed: its result is an error, or a bash call's
// exit is not 0 (its status says so).
function failed(result: { output: string; isError?: boolean; interrupted?: 'canceled' | 'stopped' } | undefined, bash: boolean): boolean {
	return !!result && !!bashResult.failure(result, bash)
}

// How `item` starts. A message queued for the turn end is its queue
// card's one row.
function initial(item: Shown, blocks?: SessionMeta['blocks'], failed = false): Fold {
	if (item.canceledReference && card.toggles(item)) return 'short'
	if (item.type === 'prompt' && item.waiting && item.delivery === 'after-turn') return 'short'
	let k = card.kind(item, failed)
	return k ? card.verbosity(k, blocks) : 'long'
}

// What every kind starts as, and the glimpse rows: a layout made under
// another signature is stale.
function signature(blocks?: SessionMeta['blocks']): string {
	return `${card.kinds.map((k) => card.verbosity(k, blocks)[0]).join('')}${settings.glimpseRows()}`
}

function text(item: Shown & { type: 'prompt' | 'text' | 'thinking' }): string {
	if (item.type === 'text') return summary.answer(item.text)
	if (item.type === 'thinking') return item.text
	return bashResult.background(item) ? bashResult.display(item.text) : item.report ? summary.answer(item.text) : item.summary ? summary.strip(item.text) : item.text
}

function markdown(item: Shown): boolean {
	return item.type === 'text' || item.type === 'thinking' || item.type === 'output' || (item.type === 'prompt' && !!item.from && !bashResult.background(item))
}

export const card = { kinds, levels, kind, toggles, setting, verbosity, failed, initial, signature, text, markdown }
