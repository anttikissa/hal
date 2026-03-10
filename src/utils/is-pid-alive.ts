export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
	} catch (e: any) {
		return e?.code === 'EPERM'
	}
	// Process exists, but check if it's stopped/suspended (state "T").
	// A suspended owner can't process commands, so treat it as dead.
	try {
		const result = Bun.spawnSync(['ps', '-o', 'state=', '-p', String(pid)])
		const state = result.stdout.toString().trim()
		if (state.startsWith('T')) return false
	} catch {
		// If ps fails, assume alive to be safe
	}
	return true
}

export const processState = { isPidAlive }
