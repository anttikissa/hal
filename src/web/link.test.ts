import { afterEach, expect, test } from 'bun:test'
import { ason } from '../common/ason.ts'
import { connection, type LinkState } from '../common/connection.ts'
import type { Event } from '../common/protocol.ts'
import { link, type Socket } from './link.ts'

class FakeSocket implements Socket {
	sent: any[] = []
	onopen: (() => void) | null = null
	onmessage: ((m: { data: unknown }) => void) | null = null
	onclose: (() => void) | null = null
	send(data: string) {
		this.sent.push(ason.parse(data))
	}
	close() {
		this.onclose?.()
	}
}

const origSchedule = connection.schedule
afterEach(() => {
	connection.stop()
	connection.schedule = origSchedule
})

function setup() {
	let sockets: FakeSocket[] = []
	let timers: (() => void)[] = []
	let events: Event[] = []
	let states: LinkState[] = []
	connection.schedule = (fn) => (timers.push(fn), 0 as any)
	link.start({
		dial: () => {
			let s = new FakeSocket()
			sockets.push(s)
			return s
		},
		onEvent: (e) => events.push(e),
		onState: (s) => states.push(s),
	})
	return { sockets, timers, events, states }
}

test('commands go out as ASON once open; events arrive parsed, junk is dropped', async () => {
	let { sockets, events } = setup()
	connection.send({ type: 'open-newest' })
	sockets[0]!.onopen!()
	await Bun.sleep(0)
	expect(sockets[0]!.sent).toMatchObject([{ type: 'open-newest', id: expect.any(String) }])
	sockets[0]!.onmessage!({ data: 'not ason {' })
	sockets[0]!.onmessage!({ data: ason.stringify({ type: 'rejected', command: 'x', reason: 'y' }, 'short') })
	expect(events).toEqual([{ type: 'rejected', command: 'x', reason: 'y' }])
})

test('a socket that never opens is a failed attempt; one that closes redials and resends', async () => {
	let { sockets, timers, states } = setup()
	sockets[0]!.onclose!()
	await Bun.sleep(0)
	expect(states.at(-1)!.type).toBe('disconnected')
	timers.shift()!()
	sockets[1]!.onopen!()
	await Bun.sleep(0)
	expect(states.at(-1)).toEqual({ type: 'connected', role: 'client' })
	connection.send({ type: 'open-newest' })
	sockets[1]!.onclose!()
	// Dropped: redials at once, and the unanswered command goes again.
	sockets[2]!.onopen!()
	await Bun.sleep(0)
	expect(sockets[2]!.sent).toEqual(sockets[1]!.sent)
})
