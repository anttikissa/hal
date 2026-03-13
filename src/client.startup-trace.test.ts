import { beforeEach, expect, test } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './cli/transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from './protocol.ts'
import type { HydrationData } from './session/history.ts'
import { startupTrace } from './perf/startup-trace.ts'

class TraceTransport implements Transport {
	constructor(
		private readonly bootstrapState: BootstrapState,
		private readonly hydrationBySession: Record<string, HydrationData>,
	) {}

	async sendCommand(_cmd: RuntimeCommand): Promise<void> {}

	async bootstrap(): Promise<BootstrapState> {
		return this.bootstrapState
	}

	async hydrateSession(sessionId: string): Promise<HydrationData> {
		return this.hydrationBySession[sessionId] ?? { replayMessages: [], inputHistory: [] }
	}

	async eventsOffset(): Promise<number> {
		return 0
	}

	tailEvents(_fromOffset?: number): { items: AsyncGenerator<RuntimeEvent>; cancel(): void } {
		return {
			items: (async function* () {
				return
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

beforeEach(() => {
	startupTrace.resetForTests()
})

test('client prints startup timeline lines', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const originalHal = (globalThis as any).__hal
	;(globalThis as any).__hal = {
		startupEpochMs: Date.now() - 200,
		startupReadyElapsedMs: 80,
		startupHostRuntimeElapsedMs: 60,
	}
	startupTrace.markAt('first-code', 27, 'post-import lower bound')
	startupTrace.markAt('runtime-ready', 60, 'host runtime ready')
	startupTrace.markAt('cli-ready', 80, 'first frame visible + prompt ready')
	try {
		const transport = new TraceTransport(
			bootstrapStateFor(sessionId),
			{ [sessionId]: { replayMessages: [{ role: 'user', content: 'hello', ts: new Date().toISOString() }], inputHistory: [] } },
		)
		const client = new Client(transport, () => {})
		await client.start()
		const tab = client.activeTab()
		const lines = (tab?.blocks ?? [])
			.filter((block) => block.type === 'info' && block.text.startsWith('[perf] t+'))
			.map((block) => block.type === 'info' ? block.text : '')
		expect(lines.some((line) => line.includes('first line of code executed'))).toBe(true)
		expect(lines.some((line) => line.includes('runtime initialized'))).toBe(true)
		expect(lines.some((line) => line.includes('cli initialized'))).toBe(true)
		expect(lines.some((line) => line.includes('current tab messages loaded'))).toBe(true)
		expect(lines.some((line) => line.includes('interactive'))).toBe(true)
	} finally {
		if (originalHal === undefined) delete (globalThis as any).__hal
		else (globalThis as any).__hal = originalHal
	}
})
