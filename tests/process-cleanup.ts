// Test-process cleanup helpers.
//
// Some integration tests spawn full `bun src/main.ts` instances. When a test
// fails or times out before it reaches its normal Ctrl-C path, those children
// can outlive the test and pile up as orphaned `bun` processes. This helper
// gives every test file one place to perform best-effort cleanup.

export async function cleanupSpawned(processes: Array<ReturnType<typeof Bun.spawn>>): Promise<void> {
	const pending = [...processes]
	processes.length = 0
	if (pending.length === 0) return

	// First ask politely: close stdin so CLI-driven children can finish their
	// normal shutdown path and flush any final state.
	for (const proc of pending) {
		if (await hasExited(proc)) continue
		const stdin = proc.stdin
		if (!stdin || typeof stdin === 'number') continue
		try {
			stdin.end()
		} catch {
			// The pipe may already be closed or the process may already be gone.
		}
	}

	await Bun.sleep(100)

	// Next send SIGTERM. Hal already handles SIGTERM explicitly, so this should
	// release host.lock and exit cleanly in the common case.
	for (const proc of pending) {
		if (await hasExited(proc)) continue
		try {
			proc.kill('SIGTERM')
		} catch {
			// Ignore races with an already-exited child.
		}
	}

	await Bun.sleep(250)

	// Last resort: SIGKILL any process that ignored EOF + SIGTERM. This keeps
	// failed test runs from leaving hundreds of orphaned `bun` processes behind.
	for (const proc of pending) {
		if (await hasExited(proc)) continue
		try {
			proc.kill('SIGKILL')
		} catch {
			// Ignore races with an already-exited child.
		}
	}

	await Promise.all(pending.map((proc) => proc.exited.catch(() => -1)))
}

async function hasExited(proc: ReturnType<typeof Bun.spawn>): Promise<boolean> {
	return await Promise.race([
		proc.exited.then(() => true),
		Bun.sleep(0).then(() => false),
	])
}
