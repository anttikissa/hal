import { afterEach, expect, test } from 'bun:test'
import { ason } from '../common/ason.ts'
import type { Event } from '../common/protocol.ts'
import { link, type Socket } from './link.ts'

class FakeSocket implements Socket {
	sent: unknown[] = []
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

function setup(opening: () => unknown = () => ({ type: 'open', sessionId: 's' })) {
	let sockets: FakeSocket[] = []
	let timers: { fn: () => void; ms: number }[] = []
	let events: Event[] = []
	let connected: boolean[] = []
	link.start({
		dial: () => {
			let s = new FakeSocket()
			sockets.push(s)
			return s
		},
		opening: async () => opening(),
		onEvent: (e) => events.push(e),
		onConnected: (up) => connected.push(up),
		setTimeout: (fn, ms) => timers.push({ fn, ms }),
	})
	return { sockets, timers, events, connected }
}

afterEach(() => link.stop())

test('each connect sends the opening command and events arrive parsed', async () => {
	let { sockets, events, connected } = setup()
	expect(link.send({ type: 'cancel', sessionId: 's' })).toBe(false)
	sockets[0]!.onopen!()
	await Bun.sleep(0)
	expect(sockets[0]!.sent).toEqual([{ type: 'open', sessionId: 's' }])
	sockets[0]!.onmessage!({ data: 'not ason {' })
	sockets[0]!.onmessage!({ data: ason.stringify({ type: 'rejected', command: 'x', reason: 'y' }, 'short') })
	expect(events).toEqual([{ type: 'rejected', command: 'x', reason: 'y' }])
	expect(connected).toEqual([true])
})

test('a dropped connection redials with growing, capped backoff and reopens', async () => {
	let n = 0
	let { sockets, timers, connected } = setup(() => ({ type: 'open', sessionId: `s${n++}` }))
	sockets[0]!.onopen!()
	await Bun.sleep(0)
	sockets[0]!.onclose!()
	expect(connected).toEqual([true, false])
	expect(link.send({ type: 'cancel', sessionId: 's' })).toBe(false)
	// Failed dials back off further, up to the cap.
	let waits: number[] = []
	for (let i = 0; i < 10; i++) {
		let t = timers.shift()!
		waits.push(t.ms)
		t.fn()
		sockets.at(-1)!.onclose!()
	}
	expect(waits.slice(0, 3)).toEqual([250, 500, 1000])
	expect(Math.max(...waits)).toBe(link.maxDelayMs())
	expect(connected).toEqual([true, false])
	// A successful connect resets the backoff and asks for the opening again.
	timers.shift()!.fn()
	let s = sockets.at(-1)!
	s.onopen!()
	await Bun.sleep(0)
	expect(s.sent).toEqual([{ type: 'open', sessionId: 's1' }])
	s.onclose!()
	expect(timers.at(-1)!.ms).toBe(250)
})

test('stop closes without redialing', () => {
	let { sockets, timers } = setup()
	sockets[0]!.onopen!()
	link.stop()
	expect(timers).toEqual([])
})
