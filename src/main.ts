import { ensureStateDir } from "./state.ts"
import { claimHost, readHostLock, releaseHost } from "./ipc.ts"
import { startRuntime } from "./server/runtime.ts"
import { startCli } from "./client/cli.ts"

ensureStateDir()

const isHost = await claimHost()
const lock = readHostLock()

if (isHost) {
	console.log(`Server started (pid ${process.pid})`)
} else {
	console.log(`Joined server (pid ${lock?.pid})`)
}

const ac = new AbortController()

function cleanup() {
	ac.abort()
	if (isHost) releaseHost()
}

process.on("exit", cleanup)
process.on("SIGTERM", () => { cleanup(); process.exit(0) })

if (isHost) {
	startRuntime(ac.signal)
}

startCli(ac.signal)
