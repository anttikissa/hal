// Context boundaries wait for the active exchange, not for their own tool.
// Intent and completion are ordinary output records, durable in history.
import { contextTransition, type ContextTransition } from '../common/context-transition.ts'
import { inbox } from '../common/inbox.ts'
import type { Sender } from '../common/blocks.ts'
import { compact } from './compact.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'

function pending(id: string): ContextTransition | undefined {
	return contextTransition.pending(history.readSync(id))
}

function output(id: string, text: string, fields: { transition?: ContextTransition; transitionDone?: string; transitionCancel?: string }): void {
	let r = history.append(id, { type: 'output', text, ...fields })
	if (!fields.transitionDone) host.broadcast(id, { type: 'output', sessionId: id, text, n: r.n, ts: r.ts })
}

function request(id: string, kind: 'clear' | 'compact', prompt: string, sender: Sender = {}): { result?: string; say?: string; error?: string } {
	if (contextTransitions.pending(id)) return { error: 'a context transition is already pending; wait or press Escape' }
	if (!turns.state.running.has(id) && !prompt.length && !compact.anything(history.readSync(id)) && history.readSync(id).findLast((r) => r.type === 'compact' || r.type === 'reset')?.type !== 'compact') return { say: kind === 'clear' ? 'the context is already empty' : 'nothing to compact' }
	let intent: ContextTransition = { id: crypto.randomUUID(), kind, sender: inbox.sender({ ...sender, advisory: undefined, steering: undefined, summary: undefined }), ...(kind === 'clear' && prompt.length && { prompt }) }
	contextTransitions.output(id, `/${kind} accepted; applying after active work settles.`, { transition: intent })
	let running = turns.state.running.get(id)
	let state = status.stateOf(id)
	if (!running) {
		if (kind === 'clear') contextTransitions.settle(id)
		if (kind === 'clear' && state.type !== 'idle') {
			history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
			status.state.states.delete(id)
			host.broadcast(id, { type: 'state', sessionId: id, state: status.derive(id, history.readSync(id)) })
		}
		contextTransitions.apply(id)
	}
	else if (kind === 'clear' && (state.type !== 'running' || state.phase !== 'tools')) running.controller.abort()
	return { result: `/${kind} accepted; the host applies it after this exchange settles.` }
}

function cancel(id: string): void {
	let intent = contextTransitions.pending(id)
	if (intent && !intent.canceled) contextTransitions.output(id, 'Automatic context continuation canceled.', { transitionCancel: intent.id })
}

function settle(id: string): void {
	let records = history.readSync(id)
	let unanswered = new Set<string>()
	for (let r of records.slice(records.findLastIndex((r) => r.type === 'reset' || r.type === 'compact') + 1)) {
		if (r.type === 'assistant' && r.block.type === 'tool_call') unanswered.add(r.block.id)
		if (r.type === 'user') for (let b of r.blocks) if (b.type === 'tool_result') unanswered.delete(b.id)
	}
	if (unanswered.size) {
		let results = [...unanswered].map((id) => ({ type: 'tool_result' as const, id, output: 'No result: the host stopped before settlement; this call may or may not have run.', isError: true }))
		let r = history.append(id, { type: 'user', blocks: results })
		host.broadcast(id, { type: 'tool-results', sessionId: id, results, n: r.n, ts: r.ts })
	}
}

// Called only after all dispatched work and its results have settled.
// Boundary and prompt carry the intent id: each crash gap resumes once.
function apply(id: string): boolean {
	let intent = contextTransitions.pending(id)
	if (!intent) return false
	if (intent.kind === 'compact' && !intent.canceled) contextTransitions.settle(id)
	let records = history.readSync(id)
	let boundary = records.some((r) => (r.type === 'reset' || r.type === 'compact') && r.transition === intent.id)
	if (!boundary && !(intent.canceled && intent.kind === 'compact')) {
		if (intent.kind === 'compact') compact.run(id, turns.state.running.has(id) || history.unfinished(id), intent.id)
		else compact.boundary(id, { type: 'reset', transition: intent.id })
	}
	let record = records.find((r) => r.type === 'user' && r.command === intent.id)
	if (intent.kind === 'clear' && intent.prompt !== undefined && !intent.canceled && !record) {
		let blocks = [{ type: 'text' as const, text: intent.prompt, ...intent.sender, generatingCommand: 'clear' as const }]
		record = history.submit(id, blocks, intent.id)
	}
	if (record?.type === 'user' && !intent.canceled) host.broadcast(id, prompts.promptEvent(id, record))
	contextTransitions.output(id, `/${intent.kind} applied.`, { transitionDone: intent.id })
	if (record?.type === 'user' && !intent.canceled) {
		status.transition(id, { type: 'submit' })
		turns.start(id)
	}
	return true
}

export const contextTransitions = { pending, output, request, cancel, settle, apply }
