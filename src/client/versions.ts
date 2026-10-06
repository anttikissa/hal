// What the terminal shows about versions (task n1): this process's own
// (main.ts sets it from host/version.ts), the host's (its `version`
// event), and whether a new commit is checked out, which the help row
// offers to load with ctrl-r.

import type { Command } from '../common/protocol.ts'

function notice(): string | undefined {
	let { own, host } = versions.state
	return own && host && own !== host ? `host runs ${host}, this peer ${own}` : undefined
}

// Tells the host this peer's version once both are known (task jjr), so
// /version shows both; the host ignores it from its own process.
function report(send: (c: Command) => void): void {
	let { own, host, newCode } = versions.state
	if (own && host && own !== 'unknown') send({ type: 'hello', pid: process.pid, version: own, ...(newCode && { newCode: true as const }) })
}

export const versions = {
	state: { own: undefined as string | undefined, host: undefined as string | undefined, newCode: false },
	notice,
	report,
}
