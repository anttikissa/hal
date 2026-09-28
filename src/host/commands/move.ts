// /move reorders the current tab in the host's shared tab list.
import type { SlashCommand } from '../commands.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	help: () => '/move <n>: move this tab to position n (1-based); a position past the end means last.',
	run(args, _answers, ctx) {
		if (!/^[1-9]\d*$/.test(args) || !Number.isSafeInteger(Number(args))) return { error: 'position must be a positive integer (1-based)' }
		let moved = tabs.act({ type: 'tab-move', sessionId: ctx.sessionId, index: Number(args) - 1 })
		if (moved.refused) return { error: moved.refused }
		return { say: `moved to tab ${tabs.file().open.indexOf(ctx.sessionId) + 1}` }
	},
}
