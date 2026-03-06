#!/usr/bin/env bun
// Entry point — host election, then start runtime + CLI.

import { randomBytes } from 'crypto'
import { ensureStateDir } from './state.ts'
import { ensureBus, claimHost, releaseHost } from './ipc.ts'
import { startRuntime } from './runtime/runtime.ts'

ensureStateDir()
await ensureBus()

const hostId = `${process.pid}-${randomBytes(4).toString('hex')}`
const { host } = await claimHost(hostId)

if (host) {
	const runtime = await startRuntime()
	process.on('exit', () => { releaseHost(hostId) })
	process.on('SIGINT', () => { runtime.stop(); process.exit(0) })
	process.on('SIGTERM', () => { runtime.stop(); process.exit(0) })
}

// Start CLI (works whether we're host or not)
await import('./cli.ts')
