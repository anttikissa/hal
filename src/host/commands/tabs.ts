// Open tabs and, on request, every saved session (task 1tk).
import { settings } from '../../common/settings.ts'
import type { SlashCommand } from '../commands.ts'
import { sessions } from '../sessions.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	help: () => '/tabs lists open tabs, marking this session; /tabs all adds closed sessions, newest first, with their closing times. Session ids link to their tabs.',
	complete: (args) => ['all'].filter((v) => v.startsWith(args)),
	run(args, _answers, ctx) {
		if (args && args !== 'all') return { error: 'usage: /tabs [all]' }
		let open = tabs.file().open
		let rows = open.map((id) => ({ id, meta: sessions.open(id), error: undefined as string | undefined }))
		if (args) rows.push(...sessions.list().filter((s) => !open.includes(s.id)).sort((a, b) => (b.meta?.closedAt ?? b.meta?.createdAt ?? '').localeCompare(a.meta?.closedAt ?? a.meta?.createdAt ?? '')).map((s) => ({ id: s.id, meta: s.meta!, error: s.error })))
		let base = settings.webUrl().replace(/\/$/, '')
		return { say: rows.map(({ id, meta, error }) => {
			let n = open.indexOf(id)
			let where = n < 0 ? `closed ${meta?.closedAt ?? '(time not recorded)'}` : `tab ${n + 1}`
			return `- ${where}  [${id}](${base}/${id})  ${error ?? meta.name ?? id}${id === ctx.sessionId ? ' (you)' : ''}`
		}).join('\n') || 'No sessions.' }
	},
}
