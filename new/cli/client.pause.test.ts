import { test, expect, mock, beforeEach } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from '../protocol.ts'
import type { Message } from '../session/messages.ts'
import { eventId } from '../protocol.ts'

// Controllable transport: events are pushed manually, tail yields them via a promise queue.
class FakeTransport implements Transport {
	private bootstrapState: BootstrapState
	private allEvents: RuntimeEvent[] = []
	private waiters: ((event: RuntimeEvent) => void)[] = []
	private pendingEvents: RuntimeEvent[] = []
	public sentCommands: RuntimeCommand[] = []

	constructor(bootstrapState: BootstrapState) {
		this.bootstrapState = bootstrapState
	}

	async sendCommand(cmd: RuntimeCommand): Promise<void> {
		this.sentCommands.push(cmd)
	}

	async bootstrap(): Promise<BootstrapState> {
		return this.bootstrapState
	}

	async replaySession(_id: string): Promise<Message[]> {
		return []
	}

	async eventsOffset(): Promise<number> {
		return this.allEvents.length
	}

	tailEvents(fromOffset?: number): { items: AsyncGenerator<RuntimeEvent>; cancel(): void } {
		const self = this
		let cancelled = false
		return {
			items: (async function* () {
				while (!cancelled) {
					if (self.pendingEvents.length > 0) {
						yield self.pendingEvents.shift()!
					} else {
						yield await new Promise<RuntimeEvent>(resolve => {
							self.waiters.push(resolve)
						})
					}
				}
			})(),
			cancel() { cancelled = true; self.waiters.forEach(w => w(null as any)) },
		}
	}

	pushEvent(event: RuntimeEvent): void {
		this.allEvents.push(event)
		const waiter = this.waiters.shift()
		if (waiter) waiter(event)
		else this.pendingEvents.push(event)
	}
}

const ts = new Date().toISOString()
const sessionId = `t-${randomBytes(4).toString('hex')}`

function makeBootstrap(busy: boolean): BootstrapState {
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: [sessionId],
		activeSessionId: sessionId,
		busySessionIds: busy ? [sessionId] : [],
		eventsOffset: 0,
		updatedAt: ts,
	}
	const sessions: SessionInfo[] = [
		{ id: sessionId, workingDir: process.cwd(), createdAt: ts, updatedAt: ts },
	]
	return { state, sessions }
}

test('pressing pause does not optimistically clear busy — tab stays busy until runtime responds', async () => {
	const transport = new FakeTransport(makeBootstrap(true))
	let updates = 0
	const client = new Client(transport, () => { updates++ })

	// Start the client (don't await — it blocks on tailEvents)
	const startPromise = client.start()
	await Bun.sleep(50) // let startup complete

	// Tab should be busy
	const tab = client.activeTab()
	expect(tab).toBeTruthy()
	expect(tab!.busy).toBe(true)

	// Simulate pressing Esc — client sends pause command
	await client.send('pause')
	expect(transport.sentCommands.length).toBe(1)
	expect(transport.sentCommands[0].type).toBe('pause')

	// Immediately after sending pause, tab is STILL busy (no optimistic update)
	expect(tab!.busy).toBe(true)

	// Now simulate the runtime responding: [paused] line + status with busy=false
	transport.pushEvent({
		id: eventId(), type: 'line', sessionId, text: '[paused]', level: 'meta', createdAt: ts,
	})
	await Bun.sleep(10)

	// After [paused] line, tab is still busy (line events don't change busy state)
	expect(tab!.busy).toBe(true)

	// Status event clears busy
	transport.pushEvent({
		id: eventId(), type: 'status', sessionId: null,
		busySessionIds: [], pausedSessionIds: [],
		activeSessionId: sessionId, busy: false, queueLength: 0,
		createdAt: ts,
	})
	await Bun.sleep(10)

	// NOW tab should not be busy
	expect(tab!.busy).toBe(false)
})
