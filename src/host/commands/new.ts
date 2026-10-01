// /new opens a tab after this session's, in its cwd and model, and
// shows it where this session shows. Ctrl-T does the same unrecorded.
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	run(_args, _answers, ctx) {
		let tab = tabs.act({ type: 'tab-new', cwd: ctx.cwd, after: ctx.sessionId }).tab!
		host.broadcast(ctx.sessionId, { type: 'go', sessionId: ctx.sessionId, tab })
		return { say: `opened tab ${tabs.file().open.indexOf(tab) + 1}` }
	},
}
