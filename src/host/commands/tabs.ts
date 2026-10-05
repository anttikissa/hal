// Open tabs and, on request, every saved session (task 1tk).
import { settings } from '../../common/settings.ts'
import type { SlashCommand } from '../commands.ts'
import { sessions, type SessionListing } from '../sessions.ts'
import { tabs } from '../tabs.ts'

// Closed sessions, newest closed first. /go and /resume use them too.
export function closedSessions(): SessionListing[] {
	let open = tabs.file().open
	let when = (s: SessionListing) => s.meta?.closedAt ?? s.meta?.createdAt ?? ''
	return sessions.list().filter((s) => !open.includes(s.id)).sort((a, b) => when(b).localeCompare(when(a)))
}

// One row: where the session is, its id as a link, its name.
export function sessionRow({ id, meta, error }: SessionListing, self: string): string {
	let n = tabs.file().open.indexOf(id)
	let where = n < 0 ? `closed ${meta?.closedAt ?? '(time not recorded)'}` : `tab ${n + 1}`
	return `- ${where}  [${id}](${settings.webUrl().replace(/\/$/, '')}/${id})  ${error ?? meta?.name ?? id}${id === self ? ' (you)' : ''}`
}

export const command: SlashCommand = {
	help: () => '/tabs lists open tabs, marking this session; /tabs all adds closed sessions, newest first, with their closing times. Session ids link to their tabs.',
	complete: (args) => ['all'].filter((v) => v.startsWith(args)),
	run(args, _answers, ctx) {
		if (args && args !== 'all') return { error: 'usage: /tabs [all]' }
		let rows: SessionListing[] = tabs.file().open.map((id) => ({ id, meta: sessions.open(id) }))
		if (args) rows.push(...closedSessions())
		return { say: rows.map((r) => sessionRow(r, ctx.sessionId)).join('\n') || 'No sessions.' }
	},
}
