import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from '../protocol.ts'
import type { Message } from '../session/messages.ts'

class FakeTransport implements Transport {
	private readonly bootstrapState: BootstrapState
	private readonly events: RuntimeEvent[] = []
	private replayStarted = false
	private releaseReplay: (() => void) | null = null
	private readonly replayGate: Promise<void>
	public offsetCalls = 0

	constructor(bootstrapState: BootstrapState) {
		this.bootstrapState = bootstrapState
		this.replayGate = new Promise<void>((resolve) => {
			this.releaseReplay = resolve
		})
	}

	async sendCommand(_cmd: RuntimeCommand): Promise<void> {}

	async bootstrap(): Promise<BootstrapState> {
		return this.bootstrapState
	}

	async replaySession(_id: string): Promise<Message[]> {
		this.replayStarted = true
		await this.replayGate
		return []
	}

	async eventsOffset(): Promise<number> {
		this.offsetCalls += 1
		return this.events.length
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

	pushEvent(event: RuntimeEvent): void {
		this.events.push(event)
	}

	openReplayGate(): void {
		this.releaseReplay?.()
	}

	hasReplayStarted(): boolean {
		return this.replayStarted
	}
}

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now()
	return new Promise((resolve, reject) => {
		const tick = async () => {
			if (condition()) {
				resolve()
				return
			}
			if (Date.now() - start > timeoutMs) {
				reject(new Error('timeout waiting for condition'))
				return
			}
			await Bun.sleep(10)
			void tick()
		}
		void tick()
	})
}

test('client does not miss events emitted during startup replay', async () => {
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
	const transport = new FakeTransport({ state, sessions })
	const updates: string[] = []
	const client = new Client(transport, () => {
		updates.push('u')
	})

	const startPromise = client.start()
	await waitFor(() => transport.offsetCalls > 0 && transport.hasReplayStarted())

	transport.pushEvent({
		id: 'e-during-replay',
		type: 'line',
		sessionId,
		text: 'event during replay window',
		level: 'info',
		createdAt: ts,
	})
	transport.openReplayGate()

	await startPromise
	await waitFor(() => updates.length >= 2)

	const tab = client.activeTab()
	expect(tab).toBeTruthy()
	expect(tab!.blocks.some((b) => b.type === 'assistant' && b.text === 'event during replay window')).toBe(true)
})
