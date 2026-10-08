// Socket transport, host end. Processes sharing a home meet at
// state/host.sock. Whoever holds an exclusive flock on state/host.lock is
// host and alone may create or replace the socket.
//
// The kernel drops a flock when its holder dies, however it dies (kill -9
// included), so a stale lock is one nobody holds and exactly one process
// can take it over. The lock file itself is never deleted or replaced: a
// lock on a new file would not exclude the holder of the old one. Our fds
// are close-on-exec, so child processes never inherit the lock.
//
// Each socket connection is one host.adapt() connection, both ways as
// line-delimited ASON (src/common/lines.ts). The host also serves the
// web endpoint (web.ts), started by main.ts after the first frame and
// stopped here with the host.
// Tasks: ja, rqq.

import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, openSync, rmSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { lines } from '../common/lines.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { secrets } from './secrets.ts'
import { web } from './web.ts'

const LOCK_EX = 2
const LOCK_NB = 4

function lockPath(): string {
	return `${paths.stateDir()}/host.lock`
}

function socketPath(): string {
	return `${paths.stateDir()}/host.sock`
}

let libc: { flock: (fd: number, op: number) => number } | undefined

function flock(fd: number, op: number): number {
	libc ??= dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	}).symbols
	return libc.flock(fd, op)
}

// Takes the host lock without waiting. True if this process holds it.
function tryLock(): boolean {
	if (server.state.lockFd !== null) return true
	let fd = openSync(server.lockPath(), 'a', 0o600)
	if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
		closeSync(fd)
		return false
	}
	server.state.lockFd = fd
	return true
}

// Becomes host if nobody is: takes the lock, then replaces whatever
// socket a previous host left and listens on it. False if another
// process is host. Idempotent.
async function serve(): Promise<boolean> {
	if (server.state.listener) return true
	if (!server.tryLock()) return false
	// Only the lock holder moves credentials into secrets/ (task de): a
	// peer doing it while an older host still refreshes tokens into
	// auth.ason would leave a stale copy that wins.
	secrets.migrate(['auth.ason', 'state/push-vapid.ason', 'state/push-subscriptions.ason'])
	try {
		server.state.listener = await server.listen(server.socketPath())
	} catch (e) {
		closeSync(server.state.lockFd!)
		server.state.lockFd = null
		throw e
	}
	return true
}

// Why this home can't have a host socket, or undefined: sockaddr_un
// holds 104 bytes on macOS (108 on Linux), NUL included.
function pathProblem(path = server.socketPath()): string | undefined {
	let bytes = Buffer.byteLength(path)
	if (bytes > 103) return `the socket path ${path} is ${bytes} bytes, over the 103-byte limit for Unix sockets; use a shorter HAL_HOME`
	return undefined
}

async function listen(path: string): Promise<Server> {
	let problem = server.pathProblem(path)
	if (problem) throw new Error(problem)
	rmSync(path, { force: true })
	let listener = createServer((socket) => server.accept(socket))
	await new Promise<void>((resolve, reject) => {
		listener.once('error', reject)
		listener.listen(path, () => {
			listener.off('error', reject)
			resolve()
		})
	})
	return listener
}

function accept(socket: Socket): void {
	server.state.sockets.add(socket)
	let conn = host.adapt((message) => {
		if (!socket.destroyed) socket.write(`${message}\n`)
	}, { kind: 'peer' })
	socket.on(
		'data',
		lines.decoder(
			(line) => conn.receive(line as string),
			(e) => conn.unreadable(e.message),
			lines.maxLine,
			(line) => line,
		),
	)
	// A client that vanishes mid-write is just gone; 'close' follows.
	socket.on('error', () => {})
	socket.on('close', () => {
		conn.close()
		server.state.sockets.delete(socket)
	})
}

// Stops serving and releases the lock, so another process can take over.
async function stop(): Promise<void> {
	let { listener, lockFd } = server.state
	server.state.listener = null
	server.state.lockFd = null
	await web.stop()
	for (let socket of server.state.sockets) socket.destroy()
	if (listener) await new Promise((resolve) => listener.close(resolve))
	if (lockFd !== null) {
		// Only the lock holder may remove the socket.
		rmSync(server.socketPath(), { force: true })
		closeSync(lockFd)
	}
}

export const server = {
	state: {
		lockFd: null as number | null,
		listener: null as Server | null,
		sockets: new Set<Socket>(),
	},
	lockPath,
	socketPath,
	pathProblem,
	tryLock,
	serve,
	listen,
	accept,
	stop,
}
