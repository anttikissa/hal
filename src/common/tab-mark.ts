// The one mark after a tab's number, the same in every client: the
// terminal's tab bar colors it, the web's tab strip styles it by
// kind. From the session state (tasks/j1/states.md) and whether the
// tab wants attention (its turn ended, failed or asked since a client
// showed it), plus durable question metadata (task kx2).

import type { Tab } from './protocol.ts'

export type MarkKind = 'asking' | 'approval' | 'blocked' | 'retrying' | 'working' | 'jobs' | 'failed' | 'paused' | 'done'
// `jobs`: background commands run too; a working mark then alternates
// with the jobs color every other blink.
export type Mark = { glyph: string; kind: MarkKind; blinks: boolean; label: string; jobs?: true }

function mark(tab: Tab): Mark | undefined {
	let s = tab.state
	if (s.type === 'error') return { glyph: '✗', kind: 'failed', blinks: false, label: 'failed' }
	if (s.type === 'paused') return { glyph: 'Ⅱ', kind: 'paused', blinks: false, label: 'paused' }
	if (tab.question === 'approval') return { glyph: '?', kind: 'approval', blinks: false, label: 'waiting for approval' }
	if (s.type === 'blocked') return s.reason === 'question'
		? { glyph: '?', kind: 'asking', blinks: false, label: 'waiting for an answer' }
		: { glyph: '!', kind: 'blocked', blinks: false, label: s.reason }
	if (s.type === 'running' && tab.jobs) return { glyph: '▪', kind: 'working', blinks: true, label: 'working, background jobs running', jobs: true }
	if (s.type === 'running') return { glyph: '▪', kind: 'working', blinks: true, label: 'working' }
	if (s.type === 'retrying') return { glyph: '▪', kind: 'retrying', blinks: true, label: 'waiting to retry' }
	if (tab.question === 'ordinary') return { glyph: '?', kind: 'asking', blinks: false, label: 'waiting for an answer' }
	// Idle: its last turn finished and nobody has looked yet.
	if (tab.attention) return { glyph: '✓', kind: 'done', blinks: false, label: 'finished, not seen' }
	if (tab.jobs) return { glyph: '▪', kind: 'jobs', blinks: true, label: 'background jobs running' }
	return undefined
}

export const tabMark = { mark }
