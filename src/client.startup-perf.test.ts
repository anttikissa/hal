import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './cli/transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from './protocol.ts'
import type { Message, HydrationData } from './session/history.ts'
import { history } from './session/history.ts'
import { draft } from './cli/draft.ts'

class FakeTransport implements Transport {
	private readonly bootstrapState: BootstrapState
	private readonly events: RuntimeEvent[]
	private readonly replays: Record<string, Message[]>
	private readonly replayGates = new Map<string, Promise<void>>()
	private readonly releaseReplayBySession = new Map<string, () => void>()
	private readonly replayStarted = new Set<string>()

	constructor(
		bootstrapState: BootstrapState,
		events: RuntimeEvent[] = [],
		replays: Record<string, Message[]> = {},
		blockedReplaySessions: string[] = [],
	) {
		this.bootstrapState = bootstrapState
		this.events = events
		this.replays = replays
		for (const sessionId of blockedReplaySessions) {
			this.replayGates.set(sessionId, new Promise<void>((resolve) => {
				this.releaseReplayBySession.set(sessionId, resolve)
			}))
		}
	}

	async sendCommand(_cmd: RuntimeCommand): Promise<void> {}

	async bootstrap(): Promise<BootstrapState> {
		return this.bootstrapState
	}

	async replaySession(sessionId: string): Promise<Message[]> {
		this.replayStarted.add(sessionId)
		const gate = this.replayGates.get(sessionId)
		if (gate) await gate
		return this.replays[sessionId] ?? []
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

	hasReplayStarted(sessionId: string): boolean {
		return this.replayStarted.has(sessionId)
	}

	releaseReplay(sessionId: string): void {
		this.releaseReplayBySession.get(sessionId)?.()
		this.releaseReplayBySession.delete(sessionId)
		this.replayGates.delete(sessionId)
	}
}

class HydrationTransport extends FakeTransport {
	private readonly hydrationBySession: Record<string, HydrationData>

	constructor(
		bootstrapState: BootstrapState,
		hydrationBySession: Record<string, HydrationData>,
		events: RuntimeEvent[] = [],
		replays: Record<string, Message[]> = {},
	) {
		super(bootstrapState, events, replays)
		this.hydrationBySession = hydrationBySession
	}

	async hydrateSession(sessionId: string): Promise<HydrationData> {
		const hydrated = this.hydrationBySession[sessionId]
		if (hydrated) return hydrated
		return { replayMessages: await this.replaySession(sessionId), inputHistory: [] }
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

async function waitFor(check: () => boolean, timeoutMs = 400): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (check()) return
		await Bun.sleep(5)
	}
	throw new Error('timed out waiting for condition')
}

test('client shows startup perf breakdown with tab target', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupEpochMs: Date.now() - 60, startupReadyElapsedMs: 42 }
	try {
		const client = new Client(new FakeTransport(bootstrapStateFor(sessionId)), () => {})
		await client.start()
		const text = startupPerfText(client)
		expect(text).toContain('[perf] startup:')
		expect(text).toContain('ready 42ms')
		expect(text).toMatch(/tab \d+ms/)
		expect(text).toContain('hydrate ')
		expect(text).toContain('(target <100ms tab)')
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})


test('client shows startup-ready runtime and cli split when host timing is available', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = {
		startupEpochMs: Date.now() - 100,
		startupReadyElapsedMs: 90,
		startupHostRuntimeElapsedMs: 55,
	}
	try {
		const client = new Client(new FakeTransport(bootstrapStateFor(sessionId)), () => {})
		await client.start()
		const text = startupPerfText(client)
		expect(text).toContain('ready 90ms (runtime 55ms + cli 35ms)')
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})

test('client warns when startup tab restore exceeds target', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupEpochMs: Date.now() - 220 }
	try {
		const client = new Client(new FakeTransport(bootstrapStateFor(sessionId)), () => {})
		await client.start()
		const text = startupPerfText(client)
		expect(text?.startsWith('⚠ [perf] startup:')).toBe(true)
		expect(text).toContain('(target <100ms tab)')
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})

test('client prefers premeasured startup-ready elapsed over epoch fallback', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupEpochMs: Date.now() - 1_000, startupReadyElapsedMs: 42 }
	try {
		const client = new Client(new FakeTransport(bootstrapStateFor(sessionId)), () => {})
		await client.start()
		const text = startupPerfText(client)
		expect(text).toContain('ready 42ms')
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
		expect(text).toContain('ready 37ms')
		expect(text).toMatch(/tab \d+ms/)
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})

test('client renders active tab before replaying non-active tabs', async () => {
	const sidA = `t-${randomBytes(4).toString('hex')}`
	const sidB = `t-${randomBytes(4).toString('hex')}`
	const ts = new Date().toISOString()
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: [sidA, sidB],
		activeSessionId: sidA,
		busySessionIds: [],
		eventsOffset: 0,
		updatedAt: ts,
	}
	const sessions: SessionInfo[] = [
		{ id: sidA, workingDir: process.cwd(), createdAt: ts, updatedAt: ts },
		{ id: sidB, workingDir: process.cwd(), createdAt: ts, updatedAt: ts },
	]
	const replays: Record<string, Message[]> = {
		[sidA]: [{ role: 'user', content: 'active tab', ts } as Message],
		[sidB]: [{ role: 'user', content: 'other tab', ts } as Message],
	}
	const transport = new FakeTransport({ state, sessions }, [], replays, [sidB])
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupEpochMs: Date.now() - 40, startupReadyElapsedMs: 20 }
	let updates = 0
	try {
		const client = new Client(transport, () => { updates++ })
		const startPromise = client.start()
		await waitFor(() => transport.hasReplayStarted(sidB), 600)
		await waitFor(() => updates >= 2, 600)
		const active = client.activeTab()
		expect(active?.sessionId).toBe(sidA)
		expect(active?.blocks.some((b) => b.type === 'input' && b.text === 'active tab')).toBe(true)
		expect(startupPerfText(client)).toContain('[perf] startup:')
		const tabB = client.getState().tabs.find((tab) => tab.sessionId === sidB)
		expect(tabB).toBeTruthy()
		expect(tabB?.blocks.length).toBe(0)
		transport.releaseReplay(sidB)
		await startPromise
		expect(tabB?.blocks.some((b) => b.type === 'input' && b.text === 'other tab')).toBe(true)
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})

test('client loads input history and draft while replay is in flight', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
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
	const transport = new FakeTransport({ state, sessions }, [], { [sessionId]: [] }, [sessionId])
	const originalLoadInputHistory = history.loadInputHistory
	const originalLoadDraft = draft.loadDraft
	let historyStarted = false
	let draftStarted = false
	history.loadInputHistory = async (id: string) => {
		if (id === sessionId) historyStarted = true
		return []
	}
	draft.loadDraft = async (id: string) => {
		if (id === sessionId) draftStarted = true
		return ''
	}
	try {
		const client = new Client(transport, () => {})
		const startPromise = client.start()
		await waitFor(() => transport.hasReplayStarted(sessionId), 600)
		await waitFor(() => historyStarted && draftStarted, 600)
		transport.releaseReplay(sessionId)
		await startPromise
	} finally {
		history.loadInputHistory = originalLoadInputHistory
		draft.loadDraft = originalLoadDraft
	}
})


test('client uses transport hydration payload for replay and input history', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const ts = new Date().toISOString()
	const hydration: HydrationData = {
		replayMessages: [{ role: 'user', content: 'hydrated replay', ts } as Message],
		inputHistory: ['hydrated input history'],
	}
	const transport = new HydrationTransport(bootstrapStateFor(sessionId), { [sessionId]: hydration })
	const originalLoadInputHistory = history.loadInputHistory
	history.loadInputHistory = async () => {
		throw new Error('loadInputHistory should not run when hydrateSession is available')
	}
	try {
		const client = new Client(transport, () => {})
		await client.start()
		const tab = client.activeTab()
		expect(tab?.blocks.some((b) => b.type === 'input' && b.text === 'hydrated replay')).toBe(true)
		expect(tab?.inputHistory).toEqual(['hydrated input history'])
	} finally {
		history.loadInputHistory = originalLoadInputHistory
	}
})
