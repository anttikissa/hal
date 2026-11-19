// STOP lets the model stop a session or tool call and the work it owns
// (work.ts).
import type { Tool, ToolContext } from '../tools.ts'
import { work } from '../work.ts'

const summary = 'stop a session or tool call and the work it owns'
const help = `## STOP

Stop an execution and its owned commands and subagents recursively. Preserve tabs, sessions, history and partial output.
STOP "<session id> | <tool call id>"
- SEND traffic does not create ownership. Tool references (t123 or 123) belong to this session; bare numbers mean tool calls, not tabs.
- Reports say what stopped or could not stop. Cancellation does not undo external effects.
- Like /kill and Esc, explicit STOP interrupts even unsafeToStop calls and warns that partial changes may remain. Esc instead pauses only the current turn and leaves background commands and subagents running. HELP SUBAGENTS explains continuation.`

const parameters = { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }

const syntax = { positional: ['target'], usage: ['STOP "<session id> | <tool call id>"'] }

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	return work.stop(work.target(ctx.sessionId, input.target))
}

export const tool: Tool = { name: 'stop', summary, help, parameters, syntax, run }
