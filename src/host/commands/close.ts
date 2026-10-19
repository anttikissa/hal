// /close closes this session's tab, or the one named by number or id;
// a running turn there stops. Ctrl-W does the same unrecorded.
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { notify } from '../notify.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	quiet: true,
	help: () => '/close [tab number|session id]: close this tab, or the one named.',
	complete: (args) =>
		tabs
			.list()
			.flatMap((t, i) => [String(i + 1), t.id])
			.filter((v) => v.startsWith(args)),
	run(args, _answers, ctx) {
		let open = tabs.file().open
		let id = !args ? ctx.sessionId : /^[1-9]\d*$/.test(args) ? open[Number(args) - 1] : args
		let before = tabs.list()
		let refused = id === undefined ? 'not a tab' : tabs.act({ type: 'tab-close', sessionId: id }).refused
		if (refused) return { error: refused }
		notify.closed(host.state.clients, id!, notify.closedBy(id!, ctx.sessionId, ctx.sender, before), before)
		return { result: `closed ${id}` }
	},
}
