import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client, clientConfig } from './client.ts'
import type { Transport, BootstrapState } from './cli/transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from './protocol.ts'
import type { Message, HydrationData } from './session/history.ts'
import { draft } from './cli/draft.ts'
import { replay } from './session/replay.ts'
import { progressiveHydrateConfig } from './session/progressive-hydrate.ts'

class FakeTransport implements Transport {
	private readonly bootstrapState: BootstrapState
	private readonly events: RuntimeEvent[]
	private readonly hydrationBySession: Record<string, HydrationData>
	private readonly hydrationGates = new Map<string, Promise<void>>()
	private readonly releaseHydrationBySession = new Map<string, () => void>()
	private readonly hydrationStarted = new Set<string>()

	constructor(
		bootstrapState: BootstrapState,
		events: RuntimeEvent[] = [],
		hydrationBySession: Record<string, HydrationData> = {},
		blockedHydrationSessions: string[] = [],
	) {
		this.bootstrapState = bootstrapState
		this.events = events
		this.hydrationBySession = hydrationBySession
		for (const sessionId of blockedHydrationSessions) {
			this.hydrationGates.set(sessionId, new Promise<void>((resolve) => {
				this.releaseHydrationBySession.set(sessionId, resolve)
			}))
		}
	}

	async sendCommand(_cmd: RuntimeCommand): Promise<void> {}

	async bootstrap(): Promise<BootstrapState> {
		return this.bootstrapState
	}

	async hydrateSession(sessionId: string): Promise<HydrationData> {
		this.hydrationStarted.add(sessionId)
		const gate = this.hydrationGates.get(sessionId)
		if (gate) await gate
		return this.hydrationBySession[sessionId] ?? { replayMessages: [], inputHistory: [] }
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
		return this.hydrationStarted.has(sessionId)
	}

	releaseReplay(sessionId: string): void {
		this.releaseHydrationBySession.get(sessionId)?.()
		this.releaseHydrationBySession.delete(sessionId)
		this.hydrationGates.delete(sessionId)
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
		expect(text).toContain('(target <200ms tab)')
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
		expect(text).toContain('(target <200ms tab)')
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

test('client tails active tab events even while non-active hydration is blocked', async () => {
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
	const events: RuntimeEvent[] = [{
		id: 'ev-chunk-1',
		type: 'chunk',
		sessionId: sidA,
		text: 'live chunk',
		channel: 'assistant',
		createdAt: ts,
	}]
	const hydrationBySession: Record<string, HydrationData> = {
		[sidA]: { replayMessages: [{ role: 'user', content: 'active tab', ts } as Message], inputHistory: [] },
		[sidB]: { replayMessages: [{ role: 'user', content: 'other tab', ts } as Message], inputHistory: [] },
	}
	const transport = new FakeTransport({ state, sessions }, events, hydrationBySession, [sidB])
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
		expect(active?.blocks.some((b) => b.type === 'assistant' && b.text.includes('live chunk'))).toBe(true)
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

test('switching to unhydrated tab triggers on-demand hydration', async () => {
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
	const hydrationBySession: Record<string, HydrationData> = {
		[sidA]: { replayMessages: [{ role: 'user', content: 'active tab', ts } as Message], inputHistory: [] },
		[sidB]: { replayMessages: [{ role: 'user', content: 'other tab', ts } as Message], inputHistory: ['past input'] },
	}
	// Block hydration for sidB so background hydration can't complete before tab switch
	const transport = new FakeTransport({ state, sessions }, [], hydrationBySession, [sidB])
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = { startupEpochMs: Date.now() - 40, startupReadyElapsedMs: 20 }
	let updates = 0
	try {
		const client = new Client(transport, () => { updates++ })
		void client.start()
		await waitFor(() => client.activeTab()?.hydrated === true, 600)
		// Tab B should not be hydrated yet (blocked)
		const tabB = client.getState().tabs.find(t => t.sessionId === sidB)
		expect(tabB?.hydrated).toBe(false)
		expect(tabB?.blocks.length).toBe(0)
		// Switch to tab B — triggers on-demand hydration
		client.switchToTab(1)
		expect(client.activeTab()?.sessionId).toBe(sidB)
		// Release the hydration gate so on-demand hydration can complete
		transport.releaseReplay(sidB)
		await waitFor(() => tabB?.hydrated === true, 600)
		expect(tabB?.blocks.some((b) => b.type === 'input' && b.text === 'other tab')).toBe(true)
		expect(tabB?.inputHistory).toEqual(['past input'])
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})

test('client loads draft while hydration is in flight', async () => {
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
	const transport = new FakeTransport(
		{ state, sessions },
		[],
		{ [sessionId]: { replayMessages: [], inputHistory: [] } },
		[sessionId],
	)
	const originalLoadDraft = draft.loadDraft
	let draftStarted = false
	draft.loadDraft = async (id: string) => {
		if (id === sessionId) draftStarted = true
		return ''
	}
	try {
		const client = new Client(transport, () => {})
		const startPromise = client.start()
		await waitFor(() => transport.hasReplayStarted(sessionId), 600)
		await waitFor(() => draftStarted, 600)
		transport.releaseReplay(sessionId)
		await startPromise
	} finally {
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
	const transport = new FakeTransport(bootstrapStateFor(sessionId), [], { [sessionId]: hydration })
	const client = new Client(transport, () => {})
	await client.start()
	const tab = client.activeTab()
	expect(tab?.blocks.some((b) => b.type === 'input' && b.text === 'hydrated replay')).toBe(true)
	expect(tab?.inputHistory).toEqual(['hydrated input history'])
})
test('client can render tail first and backfill older history in background', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const ts = new Date().toISOString()
	const replayMessages: Message[] = [
		{ role: 'user', content: 'old-1', ts },
		{ role: 'user', content: 'old-2', ts },
		{ role: 'user', content: 'old-3', ts },
		{ role: 'user', content: 'newest', ts },
	]
	const transport = new FakeTransport(bootstrapStateFor(sessionId), [], {
		[sessionId]: {
			replayMessages,
			inputHistory: ['old-1', 'old-2', 'old-3', 'newest'],
		},
	})
	const originalMin = clientConfig.startupProgressiveMinMessages
	const originalTail = clientConfig.startupTailMessageCount
	const originalChunk = progressiveHydrateConfig.chunkMessages
	const originalWorker = progressiveHydrateConfig.useWorker
	const originalReplay = replay.replayToBlocks
	clientConfig.startupProgressiveMinMessages = 2
	clientConfig.startupTailMessageCount = 1
	progressiveHydrateConfig.chunkMessages = 1
	progressiveHydrateConfig.useWorker = false
	replay.replayToBlocks = async (sid, messages, model, busy, opts) => {
		if (messages.some((m: any) => m.role === 'user' && m.content === 'old-1')) await Bun.sleep(25)
		return originalReplay(sid, messages, model, busy, opts)
	}
	try {
		const client = new Client(transport, () => {})
		await client.start()
		const tab = client.activeTab()
		expect(tab?.blocks.some((b) => b.type === 'input' && b.text === 'newest')).toBe(true)
		expect(tab?.blocks.some((b) => b.type === 'input' && b.text === 'old-1')).toBe(false)
		await waitFor(() => (tab?.blocks.some((b) => b.type === 'input' && b.text === 'old-1') ?? false), 1200)
	} finally {
		replay.replayToBlocks = originalReplay
		clientConfig.startupProgressiveMinMessages = originalMin
		clientConfig.startupTailMessageCount = originalTail
		progressiveHydrateConfig.chunkMessages = originalChunk
		progressiveHydrateConfig.useWorker = originalWorker
	}
})
