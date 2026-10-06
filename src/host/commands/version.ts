// /version: the code the host runs, and the asking terminal peer's when
// it is another process (tasks n1, jjr), for bug reports.

import type { SlashCommand } from '../commands.ts'
import { clients } from '../clients.ts'
import { release } from '../release.ts'
import { version } from '../version.ts'

// "hal 0.1.0 +3 commits (abc1234+def5678)"
async function describe(loaded: string): Promise<string> {
	let [hash] = loaded.split('+')
	return `${await release.line(loaded === 'unknown' ? undefined : hash, loaded.includes('+'))} (${loaded})`
}

// Which restart loads a newer commit. Ctrl-R restarts only the process
// it is pressed in; /restart restarts the host and every client.
function hint(hostNew: boolean, peerNew: boolean, peer: boolean): string {
	if (hostNew) return `A newer commit is checked out; /restart loads it on the host and every client${peer ? ' (Ctrl-R reloads only this client)' : ''}.`
	if (peerNew) return 'A newer commit is checked out; Ctrl-R loads it in this client (/restart also restarts the host and every client).'
	return ''
}

export const command: SlashCommand = {
	help: () => "/version shows the release and commit the host started from, plus a short hash of the uncommitted diff when there was one. Asked from a terminal peer (a separate process), it shows the peer's too. When a newer commit is checked out, it says which restart loads it: Ctrl-R restarts only the client it is pressed in, /restart the host and every client.",
	run: async (_args, _answers, ctx) => {
		let st = version.state
		if (!st.loaded) return { say: 'version: still looking it up' }
		let rec = clients.state.senders.get(ctx.sessionId)
		let peer = rec?.kind === 'peer' && rec.goneAt === undefined && rec.version ? rec : undefined
		let lines = peer ? [`host version: ${await describe(st.loaded)}`, `peer version: ${await describe(peer.version!)}`] : [await describe(st.loaded)]
		let note = hint(st.newCode, !!peer?.newCode, !!peer)
		return { say: [...lines, ...(note ? [note] : [])].join('\n') }
	},
}
