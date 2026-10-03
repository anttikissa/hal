// /notifications: the notification history (task 33, after py), newest
// last, each linked to its triggering block, else its session.

import { notices } from '../../common/notices.ts'
import { settings } from '../../common/settings.ts'
import { transcript } from '../../common/transcript.ts'
import type { SlashCommand } from '../commands.ts'
import { noticeHistory } from '../notice-history.ts'

export const command: SlashCommand = {
	help: () => `/notifications lists past notifications, oldest first: time, tab name, why it was sent and its text, linked to where it happened. Shows the latest 10; /notifications N shows N (Infinity for all the ${noticeHistory.limit} kept).`,
	run(args) {
		let count = args ? Number(args) : 10
		if (!(count >= 1) || !(Number.isInteger(count) || count === Infinity)) return { error: 'usage: /notifications [count | Infinity]' }
		let base = settings.webUrl().replace(/\/$/, '')
		let flat = (s: string) => s.replace(/\s+/g, ' ').trim()
		let all = noticeHistory.list().toReversed()
		let lines = all.slice(-count).map((e) => {
			let href = (e.block && transcript.href(e.session, e.block)) || `/${e.session}`
			return `- ${notices.stamp(e.at)} [${flat(e.name).replace(/[[\]\\]/g, ' ')} · ${notices.reason(e)}](${base}${href})${e.line.trim() ? `: ${flat(e.line)}` : ''}`
		})
		if (!lines.length) return { say: 'No notifications yet.' }
		let hidden = all.length - lines.length
		return { say: (hidden ? `${hidden} older; /notifications Infinity shows all.\n` : '') + lines.join('\n') }
	},
}
