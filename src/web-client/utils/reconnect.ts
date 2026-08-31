const config = { retryMs: 500 }

function pause(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, reconnect.config.retryMs))
}

/** Keep the current page alive while the server restarts; report when reloading is safe. */
async function waitForServer(
	probe: () => Promise<boolean>,
	wait = reconnect.pause,
	stopped: () => boolean = () => false,
): Promise<boolean> {
	while (!stopped()) {
		try {
			if (await probe()) return true
		} catch {
			// A refused connection is the expected state while Hal is restarting.
		}
		if (!stopped()) await wait()
	}
	return false
}

export const reconnect = { config, pause, waitForServer }
