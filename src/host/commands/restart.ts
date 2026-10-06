// /restart [all]|host|both (`local`, Ctrl-R, runs in the client,
// src/client/commands/restart.ts). Bare means all. The host process exits with the
// restart code once its reply is recorded; its peers take over as
// usual, whichever wins. `both`: the client that typed it restarts
// with the host (it marked itself). `all`: every connected client is
// told first, and restarts (web: reloads) once the host has gone.
//
// While a call flagged unsafeToStop runs in any session here (task
// ker), a restart asks first: the session's followers get the restart
// dialog, and its Restart anyway sends /restart <scope> anyway. Only a
// human may skip the question; a model's `anyway` asks too.

import { toolDetails } from '../../common/tool-details.ts'
import type { FlaggedCall } from '../../common/modals.ts'
import { transcript } from '../../common/transcript.ts'
import { settings } from '../../common/settings.ts'
import type { SlashCommand } from '../commands.ts'
import { history } from '../history.ts'
import { host } from '../host.ts'
import { restartNote } from '../restart-note.ts'
import { tabs } from '../tabs.ts'
import { turns } from '../turns.ts'

const scopes = ['all', 'host', 'both', 'local']

// Exit 100, which ./run answers by starting again; main.ts has the
// terminal leave raw mode first.
export const restartProcess = { run: (): void => process.exit(100) }

export const restartGuard = { flagged }

// Long enough for the reply and the clients' restart events to leave.
const flushMs = 200

function later(): void {
	setTimeout(() => restartProcess.run(), flushMs)
}

// Every call flagged unsafeToStop running on this host now. Synchronous:
// Ctrl-R in the host's terminal asks it too (main.ts).
function flagged(): FlaggedCall[] {
	let now = Date.now()
	return [...turns.state.running].flatMap(([id, running]) => {
		let unsafe = running.unsafe
		if (!unsafe) return []
		let n = history.readSync(id).findLast((r) => r.type === 'assistant' && r.block.type === 'tool_call' && r.block.id === unsafe.call)?.n
		let key = n === undefined ? undefined : `t${n}`
		return [{ block: key ? `#${key}` : tabs.label(id), ...(key && { href: transcript.href(id, key) }), title: toolDetails.headline('bash', unsafe.input).text, ms: now - unsafe.at }]
	})
}

export const command: SlashCommand = {
	help: () =>
		[
			'/restart or /restart all restarts the host and every client connected to it.',
			settings.value('hostMode') === 'server'
				? '/restart host restarts the host; clients wait for the supervised server to return.'
				: '/restart host restarts the host; clients reconnect, and a peer may take over.',
			'/restart both restarts the host and this client.',
			'/restart local (ctrl-r) restarts this client; the web page reloads.',
			'When this client is the host, local and host restart the same process.',
			'While a call flagged unsafe to stop runs, a restart of the host asks first.',
		].join('\n'),
	complete: (args) => scopes.filter((s) => s.startsWith(args.trim())),
	describeCompletion: (args) => ({ all: 'restart the host and every connected client (default)', host: 'restart the host', both: 'restart the host and this client', local: 'restart this client (ctrl-r)' } as Record<string, string>)[args]!,
	run: (args, _answers, ctx) => {
		let [scope = 'all', anyway] = args.trim().split(/\s+/).filter(Boolean)
		if (anyway !== undefined && anyway !== 'anyway') return { error: `unknown argument ${anyway}; use /restart [scope] anyway` }
		let calls = restartGuard.flagged()
		if (calls.length && (anyway === undefined || ctx.sender?.origin === 'model') && ['all', 'host', 'both'].includes(scope)) {
			host.broadcast(ctx.sessionId, { type: 'restart-ask', sessionId: ctx.sessionId, scope, calls })
			return { say: `not restarted yet: asking the user, since ${calls.map((c) => c.block).join(', ')} ${calls.length === 1 ? 'is' : 'are'} unsafe to stop` }
		}
		if (scope === 'all') for (let client of host.state.clients) client.deliver({ type: 'restart' })
		else if (scope !== 'host' && scope !== 'both') return { error: scope === 'local' ? 'only a client can restart itself; use /restart host' : `unknown scope ${scope}; use ${scopes.join(', ')}` }
		restartNote.write(`${tabs.label(ctx.sessionId)} (/restart ${scope})`)
		later()
		return { say: scope === 'all' ? 'restarting the host and every client' : 'restarting the host' }
	},
}
