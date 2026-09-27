// wait: ends the caller's turn until the next report of a subagent it
// spawned (tasks t0, mt), which arrives as a message and starts a new turn.

import { subagents } from '../subagents.ts'
import { tabs } from '../tabs.ts'
import type { Tool } from '../tools.ts'

export const tool: Tool = {
	name: 'wait',
	description: 'Wait for the next subagent session to report back. Ends this turn; its message starts the next one.',
	parameters: { type: 'object', properties: {} },
	readOnly: true,
	async run(_input, ctx) {
		let active = subagents.running(ctx.sessionId)
		if (!active.length) return 'No subagent of this session is running: none was spawned, or all have finished. Go on without waiting.'
		ctx.endTurn?.()
		return `Waiting for ${active.map((id) => tabs.label(id)).join(', ')}. This turn ends here; the next report starts a new one.`
	},
}
