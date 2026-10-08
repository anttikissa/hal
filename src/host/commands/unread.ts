// /unread marks this tab unread, or the tabs named by number or id
// (task wr5). The tab it runs in keeps the mark until its client shows
// another tab.
import type { SlashCommand } from '../commands.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	help: () => '/unread [tab number|session id ...]: mark this tab unread, or the ones named.',
	complete: (args) => tabs.list().flatMap((t, i) => [String(i + 1), t.id]).filter((v) => v.startsWith(args)),
	run(args, _answers, ctx) {
		let open = tabs.file().open
		let names = args ? args.split(/\s+/) : [ctx.sessionId]
		let ids = names.map((n) => /^[1-9]\d*$/.test(n) ? open[Number(n) - 1] : open.includes(n) ? n : undefined)
		let bad = names.filter((_, i) => ids[i] === undefined)
		if (bad.length) return { error: `not a tab: ${bad.join(', ')}` }
		tabs.unread(ids as string[], ctx.sessionId)
		return { say: `marked unread: ${ids.join(', ')}` }
	},
}
