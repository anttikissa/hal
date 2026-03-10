import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from '../protocol.ts'
import type { Message } from '../session/messages.ts'

class FakeTransport implements Transport {
	private readonly bootstrapState: BootstrapState
	private readonly events: RuntimeEvent[]

	constructor(bootstrapState: BootstrapState, events: RuntimeEvent[] = []) {
		this.bootstrapState = bootstrapState
		this.events = events
	}

	async sendCommand(_cmd: RuntimeCommand): Promise<void> {}

	async bootstrap(): Promise<BootstrapState> {
		return this.bootstrapState
	}

	async replaySession(_id: string): Promise<Message[]> {
		return []
	}

	async eventsOffset(): Promise<number> {
		return 0
	}

	tailEvents(fromOffset?: number): { items: AsyncGenerator<RuntimeEvent>; cancel(): void } {
		const start = fromOffset ?? 0
		const snapshot = this.events.slice(start)
		return {
			items: (async function* () {
				for (const event of snapshot) yield event
			})(),
			cancel() {},
		}
	}
}

test('new tabs created from sessions event keep estimated context from SessionInfo', async () => {
	const sid = `t-${randomBytes(4).toString('hex')}`
	const ts = new Date().toISOString()
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: [sid],
		activeSessionId: sid,
		busySessionIds: [],
		eventsOffset: 0,
		updatedAt: ts,
	}
	const sessions: SessionInfo[] = [{
		id: sid,
		workingDir: process.cwd(),
		createdAt: ts,
		updatedAt: ts,
		context: { used: 2500, max: 200000, estimated: true },
	}]
	const transport = new FakeTransport({ state, sessions })
	const client = new Client(transport, () => {})
	await client.start()
	const tab = client.activeTab()
	expect(tab).toBeTruthy()
	expect(tab?.context).toEqual({ used: 2500, max: 200000, estimated: true })
})

test('existing tabs keep estimated flag from later sessions events', async () => {
	const sid = `t-${randomBytes(4).toString('hex')}`
	const ts = new Date().toISOString()
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: [sid],
		activeSessionId: sid,
		busySessionIds: [],
		eventsOffset: 0,
		updatedAt: ts,
	}
	const sessions: SessionInfo[] = [{
		id: sid,
		workingDir: process.cwd(),
		createdAt: ts,
		updatedAt: ts,
	}]
	const update: RuntimeEvent = {
		type: 'sessions',
		id: 'evt-1',
		createdAt: ts,
		activeSessionId: sid,
		sessions: [{
			id: sid,
			workingDir: process.cwd(),
			createdAt: ts,
			updatedAt: ts,
			context: { used: 1800, max: 200000, estimated: true },
		}],
	}
	const transport = new FakeTransport({ state, sessions }, [update])
	const client = new Client(transport, () => {})
	await client.start()
	const tab = client.activeTab()
	expect(tab).toBeTruthy()
	expect(tab?.context).toEqual({ used: 1800, max: 200000, estimated: true })
})
