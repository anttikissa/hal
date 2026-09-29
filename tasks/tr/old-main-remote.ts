	process.exit(2)
}
if (parsedArgs.auth) {
	ensureStateDir()
	const { serverKeys } = await import('./server/server-keys.ts')
	process.stdout.write(`${serverKeys.ensureLocalToken().token}\n`)
	process.exit(0)
}
const startupCwd = resolve(parsedArgs.targetCwd || '.')

if (parsedArgs.remoteHost !== undefined) {
	ensureStateDir()
	const saved = clientPersistence.load()
	let remoteHost = parsedArgs.remoteHost ?? saved.remoteHost
	if (!remoteHost) {
		process.stderr.write('No remembered remote host; use hal -r <host>\n')
		process.exit(2)
	}
	const remoteAbort = new AbortController()
	let remoteAuthToken: string
	config.init()
	termCaps.detect()
	colors.init()
	draft.state.enabled = false
	blockData.state.blobLoadingEnabled = false
	try {
		const { webConnection } = await import('./client/web-connection.ts')
		const { remoteAuth } = await import('./client/remote-auth.ts')
		remoteHost = webConnection.normalizeHost(remoteHost)
		// The bootstrap can take seconds to arrive; the first TUI draw clears this line.
		process.stderr.write(`Connecting to ${remoteHost}...\n`)
		const rememberedToken = saved.remoteHost === remoteHost ? saved.remoteAuthToken : null
		remoteAuthToken = await remoteAuth.connect(remoteHost, rememberedToken, remoteAbort.signal)
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
		process.exit(1)
	}
	clientPersistence.save({ ...saved, remoteHost, remoteAuthToken })
	client.state.role = 'client'
	process.on('exit', () => remoteAbort.abort())
	process.on('SIGTERM', () => {
		remoteAbort.abort()
		process.exit(0)
	})
	cli.startCli(remoteAbort.signal)
	await new Promise<void>(() => {})
}

ensureStateDir()
log.state.path = `${STATE_DIR}/hal.log`
perf.mark('State directories exist')
