import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from '../protocol.ts'
import type { Message } from '../session/history.ts'

class FakeTransport implements Transport {
	private readonly bootstrapState: BootstrapState
	private readonly events: RuntimeEvent[]
	private readonly replays: Record<string, Message[]>

	constructor(bootstrapState: BootstrapState, events: RuntimeEvent[] = [], replays: Record<string, Message[]> = {}) {
		this.bootstrapState = bootstrapState
		this.events = events
		this.replays = replays
	}

	async sendCommand(_cmd: RuntimeCommand): Promise<void> {}

	async bootstrap(): Promise<BootstrapState> {
		return this.bootstrapState
	}

	async replaySession(_id: string): Promise<Message[]> {
		return this.replays[_id] ?? []
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

test('syncTabs replays history for newly added sessions', async () => {
	const sidA = `t-${randomBytes(4).toString('hex')}`
	const sidB = `t-${randomBytes(4).toString('hex')}`
	const ts = new Date().toISOString()
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: [sidA],
		activeSessionId: sidA,
		busySessionIds: [],
		eventsOffset: 0,
		updatedAt: ts,
	}
	const sessionsA: SessionInfo[] = [{
		id: sidA,
		workingDir: process.cwd(),
		createdAt: ts,
		updatedAt: ts,
	}]
	const sessionsAB: SessionInfo[] = [
		...sessionsA,
		{
			id: sidB,
			workingDir: process.cwd(),
			createdAt: ts,
			updatedAt: ts,
		},
	]
	const replayB: Message[] = [
		{ role: 'user', content: 'hello', ts },
		{ role: 'assistant', text: 'hi', ts },
	] as Message[]
	const transport = new FakeTransport({ state, sessions: sessionsA }, [], { [sidB]: replayB })
	const client = new Client(transport, () => {})
	await client.start()

	await (client as any).syncTabs(sessionsAB)

	const tabB = client.getState().tabs.find(t => t.sessionId === sidB)
	expect(tabB).toBeTruthy()
	expect(tabB?.blocks.some(b => b.type === 'input' && b.text === 'hello')).toBe(true)
	expect(tabB?.blocks.some(b => b.type === 'assistant' && b.text === 'hi')).toBe(true)
})
