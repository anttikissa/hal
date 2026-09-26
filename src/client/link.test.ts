import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import type { Event } from '../common/protocol.ts'
import { link, type Conn, type Role } from './link.ts'

// A stand-in host on the socket: records commands and answers every
// open with a snapshot of that session.
type FakeHost = { server: Server; sockets: Socket[]; commands: any[] }

let dir = ''
let hosts: FakeHost[] = []
let events: Event[] = []
let roles: (Role | null)[] = []
let hostFree = false
let localCommands: any[] = []

const path = () => `${dir}/host.sock`

function snapshotOf(id: string): Event {
	return { type: 'snapshot', sessionId: id, snapshot: { meta: { id, cwd: '/', model: 'm', createdAt: '' }, history: [], state: { type: 'idle' } } }
}

async function fakeHost(): Promise<FakeHost> {
	let h: FakeHost = { server: createServer(), sockets: [], commands: [] }
	h.server.on('connection', (socket) => {
		h.sockets.push(socket)
		socket.on('error', () => {})
		socket.on(
			'data',
			lines.decoder(
				(c: any) => {
					h.commands.push(c)
					if (c.type === 'open') socket.write(ason.stringifyLine(snapshotOf(c.sessionId)))
				},
				() => {},
			),
		)
	})
	rmSync(path(), { force: true })
	await new Promise<void>((resolve) => h.server.listen(path(), resolve))
	hosts.push(h)
	return h
}

// Kills a fake host the way a dead process would: sockets just close.
async function kill(h: FakeHost): Promise<void> {
	for (let s of h.sockets) s.destroy()
	await new Promise((resolve) => h.server.close(resolve))
}

function start(): Promise<void> {
	return link.start({
		socketPath: path(),
		tryHost: async () => hostFree,
		local: (deliver): Conn => ({
			send: (c: any) => {
				localCommands.push(c)
				if (c.type === 'open') deliver(snapshotOf(c.sessionId))
			},
			close: () => {},
		}),
		onEvent: (e) => events.push(e),
		onRole: (r) => roles.push(r),
	})
}

async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (check()) return
		await Bun.sleep(2)
	}
	throw new Error('timed out')
}

beforeEach(() => {
	dir = mkdtempSync(`${tmpdir()}/hal-link-`)
	events = []
	roles = []
	hostFree = false
	localCommands = []
})

afterEach(async () => {
	link.stop()
	for (let h of hosts) await kill(h)
	hosts = []
	rmSync(dir, { recursive: true, force: true })
})

const opened = (h: FakeHost) => h.commands.filter((c) => c.type === 'open').map((c) => c.sessionId)

test('after the host drops, followed sessions are re-opened on the next one', async () => {
	let first = await fakeHost()
	await start()
	expect(roles).toEqual(['client'])
	link.send({ type: 'open', sessionId: '1-a' })
	link.send({ type: 'open', sessionId: '2-b' })
	link.send({ type: 'open', sessionId: '3-c' })
	await until(() => events.length === 3)
	link.send({ type: 'close', sessionId: '2-b' })
	await until(() => first.commands.length === 4)

	await kill(first)
	await until(() => roles.at(-1) === null)
	let second = await fakeHost()
	await until(() => opened(second).length === 2)
	expect(opened(second).sort()).toEqual(['1-a', '3-c'])
	expect(roles).toEqual(['client', null, 'client'])
	await until(() => events.length === 5)
})

test('commands sent while disconnected reach the next host once', async () => {
	let first = await fakeHost()
	await start()
	await kill(first)
	await until(() => roles.at(-1) === null)
	link.send({ type: 'submit', sessionId: '1-a', text: 'hello' })
	let second = await fakeHost()
	await until(() => second.commands.length === 1)
	await Bun.sleep(50)
	expect(second.commands).toEqual([{ type: 'submit', sessionId: '1-a', text: 'hello' }])
})

test('when the lock is free the link becomes host and talks in-process', async () => {
	let first = await fakeHost()
	await start()
	link.send({ type: 'open', sessionId: '1-a' })
	await until(() => events.length === 1)
	hostFree = true
	await kill(first)
	await until(() => roles.at(-1) === 'host')
	expect(localCommands).toEqual([{ type: 'open', sessionId: '1-a' }])
	expect(events.length).toBe(2)
})
