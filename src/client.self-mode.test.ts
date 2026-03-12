import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './cli/transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from './protocol.ts'
import type { HydrationData } from './session/history.ts'

class FakeTransport implements Transport {
	private readonly bootstrapState: BootstrapState
	readonly sentCommands: RuntimeCommand[] = []

	constructor(bootstrapState: BootstrapState) {
		this.bootstrapState = bootstrapState
	}

	async sendCommand(cmd: RuntimeCommand): Promise<void> {
		this.sentCommands.push(cmd)
	}

	async bootstrap(): Promise<BootstrapState> {
		return this.bootstrapState
	}

	async hydrateSession(_id: string): Promise<HydrationData> {
		return { replayMessages: [], inputHistory: [] }
	}

	async eventsOffset(): Promise<number> {
		return 0
	}

	tailEvents(fromOffset?: number): { items: AsyncGenerator<RuntimeEvent>; cancel(): void } {
		const events: RuntimeEvent[] = []
		const start = fromOffset ?? 0
		return {
			items: (async function* () {
				for (const event of events.slice(start)) yield event
			})(),
			cancel() {},
		}
	}
}

function bootstrapWith(sessions: SessionInfo[], activeSessionId: string): BootstrapState {
	const ts = new Date().toISOString()
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: sessions.map(s => s.id),
		activeSessionId,
		busySessionIds: [],
		eventsOffset: 0,
		updatedAt: ts,
	}
	return { state, sessions }
}

test('self mode switches to an idle low-context tab', async () => {
	const original = process.env.HAL_SELF_MODE
	process.env.HAL_SELF_MODE = '1'
	try {
		const ts = new Date().toISOString()
		const sidA = `t-${randomBytes(4).toString('hex')}`
		const sidB = `t-${randomBytes(4).toString('hex')}`
		const sessions: SessionInfo[] = [
			{ id: sidA, workingDir: process.cwd(), createdAt: ts, updatedAt: ts, context: { used: 50_000, max: 200_000 } },
			{ id: sidB, workingDir: process.cwd(), createdAt: ts, updatedAt: ts, context: { used: 5_000, max: 200_000 } },
		]
		const transport = new FakeTransport(bootstrapWith(sessions, sidA))
		const client = new Client(transport, () => {})
		await client.start()
		expect(client.activeTab()?.sessionId).toBe(sidB)
		expect(transport.sentCommands.some(c => c.type === 'open')).toBe(false)
	} finally {
		if (original == null) delete process.env.HAL_SELF_MODE
		else process.env.HAL_SELF_MODE = original
	}
})

test('self mode opens a new tab when no idle low-context tab exists', async () => {
	const original = process.env.HAL_SELF_MODE
	process.env.HAL_SELF_MODE = '1'
	try {
		const ts = new Date().toISOString()
		const sidA = `t-${randomBytes(4).toString('hex')}`
		const sidB = `t-${randomBytes(4).toString('hex')}`
		const sessions: SessionInfo[] = [
			{ id: sidA, workingDir: process.cwd(), createdAt: ts, updatedAt: ts, context: { used: 40_000, max: 200_000 } },
			{ id: sidB, workingDir: process.cwd(), createdAt: ts, updatedAt: ts, context: { used: 35_000, max: 200_000 } },
		]
		const transport = new FakeTransport(bootstrapWith(sessions, sidA))
		const client = new Client(transport, () => {})
		await client.start()
		await Bun.sleep(10)
		expect(transport.sentCommands.some(c => c.type === 'open')).toBe(true)
	} finally {
		if (original == null) delete process.env.HAL_SELF_MODE
		else process.env.HAL_SELF_MODE = original
	}
})
