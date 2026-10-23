// /find searches every session's history (find.ts).
import type { SlashCommand } from '../commands.ts'
import { find } from '../find.ts'

export const command: SlashCommand = {
	help: () =>
		[
			'Ctrl-F or /find <query> finds the tab that did something: one row per tab, best evidence first (title, former title, commit, request, then mentions).',
			'  in:here           only this tab, listing its matching cards',
			'  in:181-ibm,12-abc those tabs; in:10-19 tab numbers 10 to 19',
			'  in:. in:~/x       tabs in this directory, or in ~/x and below',
			'  in:tools          a kind: user, hal, reasoning, tools, commits, other',
			'  "exact words"     a whole-word phrase',
			'  -word             drop tabs and cards whose id, name or text contains it',
			'  since:24h         only evidence newer than 30m, 12h, 3d, 2w...',
			'In the results, Right lists the selected tab\u2019s matching cards; Left goes back.',
		].join('\n'),
	run: async (args, _answers, ctx) => {
		if (!args.trim()) return { error: 'usage: /find <query>' }
		let hits = await find.top(args, { here: ctx.sessionId })
		return {
			say: hits.length
				? hits
						.map(
							(h) =>
								`[${h.why || h.kind}] [${h.sessionId}${h.blockId ? `/${h.card}` : ''}](${h.href}) ${h.name} · ${Math.floor(h.age / 3600000)}h · ${h.snippet.trim()}`,
						)
						.join('\n')
				: 'No matches.',
		}
	},
}
