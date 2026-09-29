import type { SlashCommand } from '../commands.ts'
import { find } from '../find.ts'

export const command: SlashCommand = {
	help: () => '/find <query> searches every session. Every word must match; in:text|thinking|tools|other, model:<name>, cwd:<path>, since:<age> (3d, 12h) restrict results.',
	run: async (args) => {
		if (!args.trim()) return { error: 'usage: /find <query>' }
		let hits = await find.top(args)
		return { say: hits.length ? hits.map((h) => `[${h.kind}] [${h.sessionId}${h.blockId ? '#' + h.blockId : ''}](${h.href}) ${h.name} · ${Math.floor(h.age / 3600000)}h · ${h.snippet}`).join('\n') : 'No matches.' }
	},
}
