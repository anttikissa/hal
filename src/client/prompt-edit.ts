import type { Block } from '../cli/block-data.ts'

export type PromptEditMode = 'amend' | 'copy' | 'side-effect-copy'

type PromptEditState = {
	sessionId: string
	mode: PromptEditMode
	originalText: string
	pausedWorkingTurn: boolean
	block?: Extract<Block, { type: 'user' }>
	previousStatus?: string
} | null

let state: { active: PromptEditState } = { active: null }

function restoreEditedBlock(): void {
	const active = state.active
	if (!active?.block) return
	active.block.status = active.previousStatus
	active.block.renderVersion = (active.block.renderVersion ?? 0) + 1
}

function start(opts: NonNullable<PromptEditState>): void {
	promptEdit.cancel()
	state.active = opts
	if (opts.block && opts.mode === 'amend') {
		opts.previousStatus = opts.block.status
		opts.block.status = 'editing'
		opts.block.renderVersion = (opts.block.renderVersion ?? 0) + 1
	}
}

function cancel(): void {
	restoreEditedBlock()
	state.active = null
}

function activeFor(sessionId?: string | null): NonNullable<PromptEditState> | null {
	const active = state.active
	if (!active) return null
	if (sessionId && active.sessionId !== sessionId) return null
	return active
}

function hint(sessionId?: string | null): string | null {
	const active = promptEdit.activeFor(sessionId)
	if (!active) return null
	if (active.mode === 'amend') return 'editing just-sent prompt — enter: send edited · ↓: continue with original · esc: stay paused'
	if (active.mode === 'side-effect-copy') return 'editing previous prompt copy — enter: send as new · alt-enter: queue · ↓/esc: cancel · /rebase: rewrite history'
	return 'editing previous prompt copy — enter: send as new · alt-enter: queue · ↓/esc: cancel'
}

export const promptEdit = { state, start, cancel, activeFor, hint }
