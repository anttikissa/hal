import type { Tool } from '../tools.ts'
import { work } from '../work.ts'

export const tool: Tool = {
	name: 'stop',
	syntax: { summary: false, positional: ['target'], usage: ['STOP <session-id|#t123>'] },
	description: 'Stop an execution and its owned commands and subagents recursively. Preserve tabs, sessions, history and partial output. SEND traffic does not create ownership. Tool references (#t123, t123 or 123) belong to this session; bare numbers mean tool calls, not tabs. Reports say what stopped or could not stop. Cancellation does not undo external effects. Like /kill and Esc, explicit STOP interrupts even unsafeToStop calls and warns that partial changes may remain. Esc instead pauses only the current turn and leaves background commands and subagents running. HELP SUBAGENTS explains continuation.',
	parameters: { type: 'object', properties: { target: { type: 'string', description: 'Session ID or local tool-call reference.' } }, required: ['target'] },
	async run(input, ctx) { return work.stop(work.target(ctx.sessionId, input.target)) },
}
