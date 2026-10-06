// /send delivers a prompt or command to a tab or session with provenance.
import { existsSync } from 'fs'
import { session } from '../../common/session.ts'
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { paths } from '../paths.ts'
import { prompts } from '../prompts.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	help: () => '/send <tab number|session id> <message>: send a prompt or slash command to one other session.',
	async run(args, _answers, ctx) {
		let match = /^(\S+)\s+([\s\S]*\S)$/.exec(args)
		if (!match) return { error: 'give a tab number or session id and a message' }
		let [, target, text] = match
		let id = /^\d+$/.test(target!) ? tabs.file().open[Number(target) - 1] : session.isId(target!) && existsSync(`${paths.sessionDir(target!)}/session.ason`) ? target : undefined
		if (!id) return { error: `no session ${target}` }
		if (id === ctx.sessionId) return { error: 'cannot send to this session itself' }
		await (host.ready(id) ?? Promise.resolve())
		let refused = prompts.submit(id, text!, undefined, 'interrupt', { from: ctx.sessionId, label: tabs.label(ctx.sessionId) })
		return refused ? { error: refused } : { say: `sent to ${tabs.label(id)}` }
	},
}
