// Check whether a process is still running.
// process.kill(pid, 0) doesn't actually kill — signal 0 just tests existence.
// Returns true if the process exists, or if we lack permission (EPERM = alive but owned by root).

export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (e: any) {
		// EPERM = process exists but we can't signal it (different user)
		return e?.code === 'EPERM'
	}
}

export const processUtils = { isPidAlive }
