// /scroll-log asks every web page to post its scroll log (scrollDebug
// setting, web/scroll-debug.ts) to this host's state/scroll-debug.log.
import { ason } from '../../common/ason.ts'
import { paths } from '../paths.ts'
import { settings } from '../../common/settings.ts'
import type { SlashCommand } from '../commands.ts'
import { web } from '../web.ts'

export const command: SlashCommand = {
	help: () =>
		"/scroll-log asks every connected web page to post its scroll log to this host's state/scroll-debug.log. Needs the scrollDebug setting.",
	run(args) {
		if (args) return { error: 'usage: /scroll-log' }
		if (!settings.scrollDebug()) return { error: '/scroll-log: turn on scrollDebug in /config first' }
		for (let ws of web.state.sockets) ws.send(ason.stringify({ type: 'scroll-log' }, 'short'))
		return { say: `Asked ${web.state.sockets.size} web pages; their logs go to ${paths.stateDir()}/scroll-debug.log.` }
	},
}
