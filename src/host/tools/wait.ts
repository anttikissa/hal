// WAIT lets the model wait until one of its sessions or tool calls
// finishes, fails or asks (work.ts).
import { callText } from '../../common/call-text.ts'
import { nativeTool } from '../native-tool.ts'
import type { Tool } from '../tools.ts'
import { work } from '../work.ts'

export const tool: Tool = {
	name: 'wait',
	syntax: {
		summary: false,
		positional: ['targets'],
		usage: [
			'WAIT [ "<session id> | <tool call id>" ... ] [ { timeout: <seconds> } ]   // until ONE of them (default: any owned work) finishes, fails or asks',
		],
		aliases: { for: 'targets', ids: 'targets', sessions: 'targets' },
		resolve(raw) {
			let { values } = callText.values(raw)
			let input = values.every((v) => typeof v === 'string' || typeof v === 'number' || Array.isArray(v))
				? { targets: values.flat() }
				: nativeTool.generic(tool, raw)
			return { name: 'wait', input }
		},
	},
	description:
		'Yield until selected work completes, fails, stops or asks a question, or until timeout seconds pass. Without targets, wait for any owned background command or subagent. Output chunks do not wake you. Completed targets return immediately; reports retain their normal delivery. Answer an agent through SEND. Tool references belong to this session; bare numbers mean tool calls, not tabs.',
	parameters: {
		type: 'object',
		properties: {
			targets: {
				type: 'array',
				items: { type: 'string' },
				description: 'Session IDs or tool-call references (t123 or 123); default any owned background work.',
			},
			timeout: { type: 'number', description: 'Seconds to wait at most; default no limit.' },
		},
	},
	async run(input, ctx) {
		if (input.timeout !== undefined && !(typeof input.timeout === 'number' && input.timeout > 0))
			throw new Error('timeout must be a positive number of seconds')
		let given = input.targets === undefined ? [] : Array.isArray(input.targets) ? input.targets : [input.targets]
		let targets = given.length ? given.map((v) => work.target(ctx.sessionId, v)) : work.defaults(ctx.sessionId)
		if (targets.some((t) => t.sessionId === ctx.sessionId && (!t.call || t.call.id === ctx.callId)))
			throw new Error('WAIT cannot wait for its own session or its own call. Name background work or another session.')
		return work.wait(targets, ctx.signal, ctx.sessionId, input.timeout as number | undefined)
	},
}
