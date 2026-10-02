// /restart host|both|all (bare and `local` run in the client,
// src/client/commands/restart.ts). The host process exits with the
// restart code once its reply is recorded; its peers take over as
// usual, whichever wins. `both`: the client that typed it restarts
// with the host (it marked itself). `all`: every connected client is
// told first, and restarts (web: reloads) once the host has gone.

import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { restartNote } from '../restart-note.ts'
import { tabs } from '../tabs.ts'

const scopes = ['local', 'host', 'both', 'all']

// Exit 100, which ./run answers by starting again; main.ts has the
// terminal leave raw mode first.
export const restartProcess = { run: (): void => process.exit(100) }

// Long enough for the reply and the clients' restart events to leave.
const flushMs = 200

function later(): void {
	setTimeout(() => restartProcess.run(), flushMs)
}

export const command: SlashCommand = {
	help: () =>
		[
			'/restart or /restart local (ctrl-r) restarts this client; the web page reloads.',
			'/restart host restarts the host; clients reconnect, and a peer may take over.',
			'/restart both restarts the host and this client.',
			'/restart all restarts the host and every client connected to it.',
			'When this client is the host, local and host restart the same process.',
		].join('\n'),
	complete: (args) => scopes.filter((s) => s.startsWith(args.trim())),
	describeCompletion: (args) => ({ local: 'restart this client (default)', host: 'restart the host', both: 'restart the host and this client', all: 'restart the host and every connected client' } as Record<string, string>)[args]!,
	run: (args, _answers, ctx) => {
		let scope = args.trim()
		if (scope === 'all') for (let client of host.state.clients) client.deliver({ type: 'restart' })
		else if (scope !== 'host' && scope !== 'both') return { error: scope === '' || scope === 'local' ? 'only a client can restart itself; use /restart host' : `unknown scope ${scope}; use ${scopes.join(', ')}` }
		restartNote.write(`${tabs.label(ctx.sessionId)} (/restart ${scope})`)
		later()
		return { say: scope === 'all' ? 'restarting the host and every client' : 'restarting the host' }
	},
}
