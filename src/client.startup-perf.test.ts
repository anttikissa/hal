import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './cli/transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from './protocol.ts'
import type { Message } from './session/history.ts'

class FakeTransport implements Transport {
	private readonly bootstrapState: BootstrapState

	constructor(bootstrapState: BootstrapState) {
		this.bootstrapState = bootstrapState
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

	tailEvents(_fromOffset?: number): { items: AsyncGenerator<RuntimeEvent>; cancel(): void } {
		return {
			items: (async function* () {})(),
			cancel() {},
		}
	}
}

function bootstrapStateFor(sessionId: string): BootstrapState {
	const ts = new Date().toISOString()
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: [sessionId],
		activeSessionId: sessionId,
		busySessionIds: [],
		eventsOffset: 0,
		updatedAt: ts,
	}
	const sessions: SessionInfo[] = [{ id: sessionId, workingDir: process.cwd(), createdAt: ts, updatedAt: ts }]
	return { state, sessions }
}

function startupPerfText(client: Client): string | null {
	const tab = client.activeTab()
	if (!tab) return null
	const perf = tab.blocks.find((block) => block.type === 'info' && block.text.includes('[perf] startup:'))
	return perf && perf.type === 'info' ? perf.text : null
}

test('client shows startup perf with 100ms target', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupEpochMs: Date.now() + 50 }
	try {
		const client = new Client(new FakeTransport(bootstrapStateFor(sessionId)), () => {})
		await client.start()
		const text = startupPerfText(client)
		expect(text).toContain('[perf] startup:')
		expect(text).toContain('(target <100ms)')
		expect(text?.startsWith('⚠ ')).toBe(false)
		const match = text?.match(/startup: (\d+)ms/)
		expect(match).toBeTruthy()
		const elapsed = Number(match![1])
		expect(elapsed).toBeGreaterThanOrEqual(0)
		expect(elapsed).toBeLessThan(100)
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})

test('client warns when startup perf exceeds target', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupEpochMs: Date.now() - 180 }
	try {
		const client = new Client(new FakeTransport(bootstrapStateFor(sessionId)), () => {})
		await client.start()
		const text = startupPerfText(client)
		expect(text?.startsWith('⚠ [perf] startup:')).toBe(true)
		expect(text).toContain('(target <100ms)')
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})
