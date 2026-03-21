import { perf } from "./perf.ts"
perf.mark("first-code")

import { ensureStateDir } from "./state.ts"
import { claimHost, readHostLock, releaseHost } from "./ipc.ts"
import { startRuntime } from "./server/runtime.ts"
import { startCli } from "./client/cli.ts"

ensureStateDir()
perf.mark("state-ready")

const isHost = await claimHost()
const lock = readHostLock()
perf.mark("host-election")

if (isHost) {
	console.log(`Server started (pid ${process.pid}) [${perf.elapsed()}ms]`)
} else {
	console.log(`Joined server (pid ${lock?.pid}) [${perf.elapsed()}ms]`)
}

const ac = new AbortController()

function cleanup() {
	ac.abort()
	if (isHost) releaseHost()
	perf.stop()
}

process.on("exit", cleanup)
process.on("SIGTERM", () => { cleanup(); process.exit(0) })

if (isHost) {
	startRuntime(ac.signal)
}

// Dump perf marks to stderr on startup
perf.setSink((lines) => {
	for (const line of lines) process.stderr.write(`  ${line}\n`)
})

perf.mark("cli-start")
startCli(ac.signal)
