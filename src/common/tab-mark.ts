// The one mark after a tab's number, the same in every client: the
// terminal's tab bar colours it, the web's tab strip styles it by
// kind. From the session state (tasks/j1/states.md) and whether the
// tab wants attention (its turn ended, failed or asked since a client
// showed it). Glyphs follow the old Hal's tabIndicator.

import type { Tab } from './protocol.ts'

export type MarkKind = 'asking' | 'working' | 'noticed' | 'failed' | 'paused' | 'done'
export type Mark = { glyph: string; kind: MarkKind; blinks: boolean; label: string }

function mark(tab: Tab): Mark | undefined {
	let s = tab.state
	if (s.type === 'blocked') return { glyph: '!', kind: 'asking', blinks: false, label: 'waiting for an answer' }
	if (s.type === 'running' && tab.attention) return { glyph: '◆', kind: 'noticed', blinks: true, label: 'working, wants attention' }
	if (s.type === 'running') return { glyph: '▪', kind: 'working', blinks: true, label: 'working' }
	if (s.type === 'retrying') return { glyph: '✗', kind: 'failed', blinks: true, label: 'retrying' }
	if (s.type === 'error') return { glyph: '✗', kind: 'failed', blinks: true, label: 'failed' }
	if (s.type === 'paused') return { glyph: '!', kind: 'paused', blinks: false, label: 'paused' }
	// Idle: its last turn finished and nobody has looked yet.
	if (tab.attention) return { glyph: '✓', kind: 'done', blinks: false, label: 'finished, not seen' }
	return undefined
}

export const tabMark = { mark }
