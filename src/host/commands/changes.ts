import { settings } from '../../common/settings.ts'
import { changes } from '../changes.ts'
import type { SlashCommand } from '../commands.ts'
import { clients } from '../clients.ts'
import { host } from '../host.ts'
import { sessions } from '../sessions.ts'
import { stats } from '../stats.ts'

export const command: SlashCommand = {
	help: () => '/changes lists the files this session declared and changed, with diffs and the calls that changed them; /changes clear starts a fresh list without deleting history.',
	complete: (args) => ['clear'].filter((s) => s.startsWith(args)),
	async run(args, _answers, ctx) {
		if (args && args !== 'clear') return { error: 'usage: /changes [clear]' }
		if (args === 'clear') {
			host.broadcast(ctx.sessionId, { type: 'turn-stats', sessionId: ctx.sessionId, stats: stats.of(ctx.sessionId) })
			return { say: 'File changes cleared; records remain in history.' }
		}
		let files = changes.list(ctx.sessionId)
		let base = settings.webUrl().replace(/\/$/, '')
		let cwd = sessions.open(ctx.sessionId)?.cwd ?? files[0]?.cwd ?? '/'
		let timeZone = clients.timezone(ctx.sessionId)
		let lines = [`[All changes](${base}${changes.href(ctx.sessionId)})`]
		for (let file of files) {
			let diff = await changes.diff(ctx.sessionId, file.before, file.after)
			let commit = await changes.committed(ctx.sessionId, file)
			let label = changes.shown(file, cwd).replace(/[[\]\\\n\r]/g, ' ')
			let ids = changes.calls(ctx.sessionId, file).map((c) => `[${c.block}](${base}${c.href})`).join(' ')
			lines.push(`- [${label}](${base}${changes.href(ctx.sessionId, file.path)})  ${changes.counts(diff)}  ${changes.time(file.ts, timeZone)}${ids ? `  ${ids}` : ''}${commit ? ` · committed in ${commit}` : ''}`)
		}
		if (!files.length) lines.push('No file changes since the last /changes clear.')
		return { say: lines.join('\n') }
	},
}
