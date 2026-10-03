// /notifications: the notification history (task 33, after py), newest
// first, each linked to its triggering block, else its session.

import { notices } from '../../common/notices.ts'
import { settings } from '../../common/settings.ts'
import { transcript } from '../../common/transcript.ts'
import type { SlashCommand } from '../commands.ts'
import { noticeHistory } from '../notice-history.ts'

export const command: SlashCommand = {
	help: () => `/notifications lists past notifications, newest first: time, tab name, why it was sent and its text, linked to where it happened. Keeps the latest ${noticeHistory.limit()}.`,
	run(args) {
		if (args) return { error: 'usage: /notifications' }
		let base = settings.webUrl().replace(/\/$/, '')
		let flat = (s: string) => s.replace(/\s+/g, ' ').trim()
		let lines = noticeHistory.list().map((e) => {
			let href = (e.block && transcript.href(e.session, e.block)) || `/${e.session}`
			return `- ${notices.stamp(e.at)} [${flat(e.name).replace(/[[\]\\]/g, ' ')} · ${notices.reason(e)}](${base}${href}): ${flat(e.line)}`
		})
		return { say: lines.join('\n') || 'No notifications yet.' }
	},
}
