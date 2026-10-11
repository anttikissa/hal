import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { createConnection, type Socket } from 'net'
import { tmpdir } from 'os'
import { lines } from '../common/lines.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'

const savedHome = process.env.HAL_HOME
const origPort = web.port
let home = ''
let sockets: Socket[] = []

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-server-`)
	process.env.HAL_HOME = home
	paths.init()
	// Never the real port: a running Hal may hold it.
	web.port = () => 0
})

afterEach(async () => {
	for (let s of sockets) s.destroy()
	sockets = []
	await server.stop()
	host.reset()
	sessions.closeAll()
	web.port = origPort
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

async function dial() {
	let socket = createConnection(server.socketPath())
	sockets.push(socket)
	let events: any[] = []
	let closed = false
	socket.on('data', lines.decoder((e) => events.push(e), () => {}))
	socket.on('close', () => (closed = true))
	await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject))
	return { socket, events, closed: () => closed }
}

async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (check()) return
		await Bun.sleep(2)
	}
	throw new Error('timed out')
}

test('commands and events cross the socket as ASON lines', async () => {
	expect(await server.serve()).toBe(true)
	let a = await dial()
	let create = lines.encode({ type: 'create', cwd: '/tmp/x', model: 'fake/m' })
	// A bad line, then a good one split mid-message.
	a.socket.write('{ not ason\n')
	a.socket.write(create.slice(0, 7))
	await Bun.sleep(5)
	a.socket.write(create.slice(7))
	await until(() => a.events.some((e) => e.type === 'snapshot'))
	expect(a.events.map((e) => e.type)).toEqual(['home', 'tabs', 'rejected', 'snapshot'])
	let snapshot = a.events.find((e) => e.type === 'snapshot')
	expect(snapshot).toMatchObject({ type: 'snapshot', snapshot: { meta: { cwd: '/tmp/x', model: 'fake/m' } } })

	let b = await dial()
	b.socket.write(lines.encode({ type: 'open', sessionId: snapshot.sessionId }))
	await until(() => b.events.some((e) => e.type === 'snapshot'))
	expect(b.events.find((e) => e.type === 'snapshot').snapshot.meta).toEqual(snapshot.snapshot.meta)
})

test('a disconnected socket is no longer a host client', async () => {
	await server.serve()
	let a = await dial()
	await until(() => host.state.clients.size === 1)
	a.socket.destroy()
	await until(() => host.state.clients.size === 0)
})

test('stop drops clients, removes the socket and frees the lock', async () => {
	await server.serve()
	let a = await dial()
	await server.stop()
	await until(() => a.closed())
	expect(existsSync(server.socketPath())).toBe(false)
	// The lock is free again: taking it now succeeds.
	expect(await server.serve()).toBe(true)
	expect(existsSync(server.socketPath())).toBe(true)
})

test('a stale socket file left by a dead host is replaced', async () => {
	await server.serve()
	await server.stop()
	await Bun.write(server.socketPath(), 'stale')
	expect(await server.serve()).toBe(true)
	let a = await dial()
	a.socket.write(lines.encode({ type: 'create', cwd: '/tmp' }))
	await until(() => a.events.some((e) => e.type === 'snapshot'))
	expect(a.events.find((e) => e.type === 'snapshot').type).toBe('snapshot')
})
