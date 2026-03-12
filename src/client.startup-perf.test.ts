import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './cli/transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from './protocol.ts'
import type { Message } from './session/history.ts'

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

async function waitFor(check: () => boolean, timeoutMs = 200): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (check()) return
		await Bun.sleep(5)
	}
	throw new Error('timed out waiting for condition')
}

test('client shows startup perf with 100ms target', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupReadyElapsedMs: 42 }
	try {
		const client = new Client(new FakeTransport(bootstrapStateFor(sessionId)), () => {})
		await client.start()
		const text = startupPerfText(client)
		expect(text).toContain('[perf] startup:')
		expect(text).toContain('(target <100ms)')
		expect(text?.startsWith('⚠ ')).toBe(false)
		expect(text).toContain('startup: 42ms')
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

test('client prefers premeasured startup elapsed over epoch fallback', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupEpochMs: Date.now() - 1_000, startupReadyElapsedMs: 42 }
	try {
		const client = new Client(new FakeTransport(bootstrapStateFor(sessionId)), () => {})
		await client.start()
		const text = startupPerfText(client)
		expect(text).toContain('startup: 42ms')
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})

test('client prints startup perf when first tab arrives from sessions event', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const ts = new Date().toISOString()
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: [],
		activeSessionId: null,
		busySessionIds: [],
		eventsOffset: 0,
		updatedAt: ts,
	}
	const sessionInfo: SessionInfo = {
		id: sessionId,
		workingDir: process.cwd(),
		createdAt: ts,
		updatedAt: ts,
	}
	const events: RuntimeEvent[] = [{
		id: 'ev-sessions-1',
		type: 'sessions',
		activeSessionId: sessionId,
		sessions: [sessionInfo],
		createdAt: ts,
	}]
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupReadyElapsedMs: 37 }
	try {
		const client = new Client(new FakeTransport({ state, sessions: [] }, events), () => {})
		await client.start()
		await waitFor(() => startupPerfText(client) !== null)
		const text = startupPerfText(client)
		expect(text).toContain('startup: 37ms')
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})
