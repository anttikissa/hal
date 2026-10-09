// /budget: models may only read it (bare /budget, tools/command.ts); only a human changes it.
import type { SlashCommand } from '../commands.ts'
import { sessions } from '../sessions.ts'
import { subagents } from '../subagents.ts'

export const command: SlashCommand = {
	help: () => '/budget: show spawn slots left. /budget <n> sets them; /budget +n or -n adjusts them.',
	run(args, _answers, ctx) {
		let meta = sessions.open(ctx.sessionId)
		let current = meta.slots ?? subagents.initialSlots
		if (!args) return { say: `${current} spawn slot${current === 1 ? '' : 's'} left` }
		if (!/^(?:[+-]?\d+)$/.test(args)) return { error: 'usage: /budget [<n>|+n|-n] (non-negative integer)' }
		let value = Number(args)
		let next = args.startsWith('+') || args.startsWith('-') ? current + value : value
		if (!Number.isSafeInteger(next) || next < 0) return { error: 'usage: /budget [<n>|+n|-n] (non-negative integer)' }
		meta.slots = next
		return { say: `${next} spawn slot${next === 1 ? '' : 's'} left` }
	},
}
