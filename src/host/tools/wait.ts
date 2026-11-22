// WAIT lets the model wait until one of its sessions or tool calls
// finishes, fails or asks (work.ts).
import type { Tool, ToolContext } from '../tools.ts'
import { work } from '../work.ts'

// Configuration: true puts the whole help in the system prompt; false
// lists only the summary under Other tools (HELP <TOOL> shows the rest).
const inPrompt = false
const summary = 'wait until sessions or tool calls finish, fail or ask'
const help = `## WAIT

Yield until selected work completes, fails, stops or asks a question, or until timeout seconds pass.
WAIT { timeout? }?                                  // any owned background command or subagent
WAIT "<session id> | <tool call id>" ... { timeout? }?   // until ONE of them
	timeout?: number    seconds; default no limit
- Output chunks do not wake you. Completed targets return immediately; reports retain their normal delivery.
- Answer an agent through SEND. Tool references (t123 or 123) belong to this session; bare numbers mean tool calls, not tabs.`

const parameters = {
	type: 'object',
	properties: {
		targets: { type: 'array', items: { type: 'string' } },
		timeout: { type: 'number' },
	},
}

const syntax = {
	positional: ['targets'],
	usage: ['WAIT { timeout? }?', 'WAIT "<session id> | <tool call id>" ... { timeout? }?'],
	aliases: { for: 'targets', id: 'targets', ids: 'targets', session: 'targets', sessions: 'targets' },
}

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	if (input.timeout !== undefined && !(typeof input.timeout === 'number' && input.timeout > 0))
		throw new Error('timeout must be a positive number of seconds')
	let given = input.targets === undefined ? [] : Array.isArray(input.targets) ? input.targets : [input.targets]
	let targets = given.length ? given.map((v) => work.target(ctx.sessionId, v)) : work.defaults(ctx.sessionId)
	if (targets.some((t) => t.sessionId === ctx.sessionId && (!t.call || t.call.id === ctx.callId)))
		throw new Error('WAIT cannot wait for its own session or its own call. Name background work or another session.')
	return work.wait(targets, ctx.signal, ctx.sessionId, input.timeout as number | undefined)
}

export const tool: Tool = { name: 'wait', inPrompt, summary, help, parameters, syntax, run }
