// What the terminal shows about versions (task n1): this process's own
// (main.ts sets it from host/version.ts), the host's (its `version`
// event), and whether a new commit is checked out, which the help row
// offers to load with ctrl-r.

function notice(): string | undefined {
	let { own, host } = versions.state
	return own && host && own !== host ? `host runs ${host}, this peer ${own}` : undefined
}

export const versions = {
	state: { own: undefined as string | undefined, host: undefined as string | undefined, newCode: false },
	notice,
}
