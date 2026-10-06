import { settings } from '../../common/settings.ts'
import { changes } from '../changes.ts'
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { stats } from '../stats.ts'

export const command: SlashCommand = {
	help: () => '/changes lists observed file changes with diffs and calls; /changes clear starts a fresh list without deleting history.',
	complete: (args) => ['clear'].filter((s) => s.startsWith(args)),
	async run(args, _answers, ctx) {
		if (args && args !== 'clear') return { error: 'usage: /changes [clear]' }
		if (args === 'clear') {
			host.broadcast(ctx.sessionId, { type: 'turn-stats', sessionId: ctx.sessionId, stats: stats.of(ctx.sessionId) })
			return { say: 'File changes cleared; records remain in history.' }
		}
		let files = changes.list(ctx.sessionId)
		let base = settings.webUrl().replace(/\/$/, '')
		let lines = [`Observed during calls, not proof of authorship. [All changes](${base}${changes.href(ctx.sessionId)})`]
		for (let file of files) {
			let diff = await changes.diff(ctx.sessionId, file.before, file.after)
			let commit = await changes.committed(ctx.sessionId, file)
			let label = file.path.replace(/[[\]\\\n\r]/g, ' ')
			lines.push(`- [${label}](${base}${changes.href(ctx.sessionId, file.path)}) ${changes.counts(diff)} · calls: ${file.steps.map((s) => s.toolId).join(', ')}${commit ? ` · committed in ${commit}` : ''}`)
		}
		if (!files.length) lines.push('No file changes since the last /changes clear.')
		return { say: lines.join('\n') }
	},
}
