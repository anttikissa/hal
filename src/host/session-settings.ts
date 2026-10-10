import { replay, type HistoryRecord } from '../common/replay.ts'
import type { SessionMeta } from '../common/session.ts'
import { models } from './models.ts'

export type SessionSettings = { cwd: string; model: string; autoclose: boolean; previousCwd?: string }

function project(meta: SessionMeta, records: HistoryRecord[]): SessionSettings {
	if (!meta.startingState) throw new Error(`Session ${meta.id} has no starting state; setting changes cannot be rebased. No migration is performed.`)
	let state: SessionSettings = { ...meta.startingState }
	for (let r of replay.current(records)) if (r.type === 'change') {
		if (r.cwd !== undefined) { state.previousCwd = state.cwd; state.cwd = r.cwd }
		if (r.model !== undefined) state.model = r.model
		if (r.autoclose !== undefined) state.autoclose = r.autoclose
	}
	models.selection(state.model)
	return state
}

function assign(meta: SessionMeta, settings: SessionSettings): void {
	let selection = models.selection(settings.model)
	meta.cwd = settings.cwd
	meta.model = selection.id
	meta.autoclose = settings.autoclose
	if (settings.previousCwd === undefined) delete meta.previousCwd
	else meta.previousCwd = settings.previousCwd
	if (selection.effort === undefined) delete meta.effort
	else meta.effort = selection.effort
}

function recover(meta: SessionMeta): boolean {
	let { history } = require('./history.ts') as typeof import('./history.ts')
	let raw = history.readSync(meta.id)
	if (!raw.some((r) => r.type === 'rebase' && r.contextChanged)) return false
	let settings = sessionSettings.project(meta, raw)
	let changed = meta.cwd !== settings.cwd || models.qualified(meta.model, meta.effort) !== settings.model || meta.autoclose !== settings.autoclose || meta.previousCwd !== settings.previousCwd
	if (changed) sessionSettings.assign(meta, settings)
	return changed
}

export const sessionSettings = { project, assign, recover }
