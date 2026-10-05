// Find unfinished turns and queued work from session marks, then continue
// it after a host restart without scanning closed, idle histories.
import { existsSync } from 'fs'
import { states } from '../common/states.ts'
import { contextTransitions } from './context-transitions.ts'
import { busy } from './busy.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { pages } from './pages.ts'
import { prompts } from './prompts.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'

async function recover(): Promise<void> {
	for (let id of new Set([...tabs.file().open, ...busy.list()])) {
		if (turns.state.running.has(id)) continue
		if (!existsSync(history.file(id))) {
			busy.drop(id)
			continue
		}
		// Startup's first-frame timeout can fire before tab indexing finishes.
		// Recovery must not finish that work synchronously through marks().
		await pages.slices(pages.catchUp(id))
		if (!turnRecovery.leftWork(id)) {
			busy.drop(id)
			continue
		}
		try {
			await (host.ready(id) ?? Promise.resolve())
		} catch (e: any) {
			diag.log(`recover ${id}: ${e?.message ?? e}`)
			continue
		}
		let records = history.readSync(id)
		if (turns.state.running.has(id)) continue
		let intent = contextTransitions.pending(id)
		if (intent) {
			if (intent.kind === 'clear') contextTransitions.settle(id)
			if (intent.kind === 'clear' && history.unfinished(id)) {
				history.append(id, { type: 'turn_end', status: intent.cancelled ? 'paused' : 'completed', usage: {} })
				status.state.states.delete(id)
			}
			contextTransitions.apply(id)
			if (intent.kind === 'clear') continue
		}
		let state = status.stateOf(id, records)
		if (state.type === 'idle') {
			prompts.next(id)
			continue
		}
		if (state.type !== 'running') continue
		let n = states.recoveries(records)
		if (n >= states.maxRecoveries()) {
			turns.stop(id, `continued ${n} times without progress; it may be what stops the host`)
			continue
		}
		history.append(id, { type: 'continue', reason: 'The host restarted during the turn. Continue without repeating completed work.' })
		turns.start(id)
	}
}

function leftWork(id: string): boolean {
	let m = pages.marks(id)
	if (m.transitions?.length) return true
	let path = history.file(id)
	let last = m.turn === undefined ? undefined : pages.lineAt(path, m.turn).record
	if (last && last.type !== 'turn_end') return true
	if (last && last.status !== 'completed') return false
	return Object.values(m.inbox).flat().some((at) => {
		let r = pages.lineAt(path, at).record
		return r.type === 'inbox' && r.queue === true
	})
}

export const turnRecovery = { recover, leftWork }
