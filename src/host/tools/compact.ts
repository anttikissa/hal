// Hands working state to the next context without deleting session history.
import { contextTransitions } from '../context-transitions.ts'
import { history } from '../history.ts'
import type { Tool } from '../tools.ts'

export const tool: Tool = {
	name: 'compact',
	syntax: {
		summary: 'replace active context with your working-state checkpoint; full history stays',
		usage: ['COMPACT { summary: "..." }'],
	},
	description:
		'Compact at a task boundary after a large investigation or before context gets too large. Call alone, after receiving all other tool results. Write a concise handoff: user goals, unresolved requests and constraints; decisions and findings (facts versus hypotheses); changes, actual verification and blockers; a next action consistent with that state; file and READ_ENTRY references. Reconcile any previous checkpoint with newer evidence. Do not restate system or project instructions. The current requests stay verbatim. After this exchange settles, the checkpoint replaces earlier model context and you continue in the same session. Full history and undo remain available.',
	parameters: {
		type: 'object',
		properties: { summary: { type: 'string', description: 'Working-state handoff needed to continue.' } },
		required: ['summary'],
	},
	async run(input, ctx) {
		if (typeof input.summary !== 'string' || !input.summary.trim()) throw new Error('COMPACT needs a nonempty summary')
		if (ctx.signal.aborted) throw new Error('turn stopped')
		let records = history.readSync(ctx.sessionId)
		let round = records.slice(records.findLastIndex((r) => r.type === 'user') + 1)
		if (round.filter((r) => r.type === 'assistant' && r.block.type === 'tool_call').length > 1)
			throw new Error(
				'Call COMPACT alone after receiving all other tool results, so the checkpoint includes their outcomes.',
			)
		let reply = contextTransitions.request(ctx.sessionId, 'compact', '', { origin: 'model' }, input.summary)
		if (reply.error) throw new Error(reply.error)
		return reply.result ?? reply.say ?? 'Checkpoint accepted.'
	},
}
