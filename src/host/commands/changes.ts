import { existsSync } from 'fs'
import { settings } from '../../common/settings.ts'
import { changeCleanup } from '../change-cleanup.ts'
import { changes } from '../changes.ts'
import type { SlashCommand } from '../commands.ts'
import { clients } from '../clients.ts'
import { findIndex } from '../find-index.ts'
import { history } from '../history.ts'
import { host } from '../host.ts'
import { liveFiles } from '../live-file.ts'
import { pages } from '../pages.ts'
import { paths } from '../paths.ts'
import { sessions } from '../sessions.ts'
import { stats } from '../stats.ts'

// Removes excluded file-change metadata from a session's history while
// the host runs; previews unless approved with `apply`.
async function cleanup(args: string[], current: string) {
	let apply = args[0] === 'apply'
	if (apply) args = args.slice(1)
	let id = args[0] ?? current
	if (args.length > 1 || !sessions.ids().includes(id) || !existsSync(`${paths.sessionDir(id)}/history.asonl`)) return { error: `usage: /changes cleanup [apply] [session-id]; no history for ${id}` }
	if (history.state.running.has(id)) return { error: `${id} has a running turn; pause it, then retry` }
	let result = await changeCleanup.run(id, apply, () => {
		let marks = pages.state.marks.get(pages.marksPath(id))
		if (marks) {
			try { liveFiles.close(marks) } catch {}
			pages.state.marks.delete(pages.marksPath(id))
		}
		history.state.cache.delete(id)
		pages.state.rebased.delete(id)
		changes.state.cache.delete(id)
		findIndex.state.db?.query('DELETE FROM marks WHERE sessionId=?').run(id)
	})
	if (result.backup) for (let client of host.state.clients) if (client.open.has(id)) host.follow(client, id)
	let summary = `${result.records} records kept; ${result.removed} excluded entries; ${result.before} → ${result.after} bytes`
	return { say: result.backup ? `Cleaned ${id}: ${summary}.\nRecoverable original: ${result.backup}` : result.removed ? `Preview of ${id}: ${summary}. Run /changes cleanup apply ${id} to remove them.` : `Nothing to clean in ${id}.` }
}

export const command: SlashCommand = {
	help: () => '/changes lists the files this session declared and changed, with diffs and the calls that changed them; /changes clear starts a fresh list without deleting history; /changes cleanup [apply] [session-id] previews, then removes, excluded generated-file metadata from a history, keeping a backup.',
	complete: (args) => ['clear', 'cleanup'].filter((s) => s.startsWith(args)),
	async run(args, _answers, ctx) {
		let words = args.split(/\s+/).filter(Boolean)
		if (words[0] === 'cleanup') {
			try { return await cleanup(words.slice(1), ctx.sessionId) } catch (e: any) { return { error: e?.message ?? String(e) } }
		}
		if (args && args !== 'clear') return { error: 'usage: /changes [clear | cleanup [apply] [session-id]]' }
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
