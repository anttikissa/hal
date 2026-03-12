import { test, expect, beforeEach, afterEach } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './cli/transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from './protocol.ts'
import type { HydrationData } from './session/history.ts'
import { prompt } from './cli/prompt.ts'

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

	async hydrateSession(_id: string): Promise<HydrationData> {
		return { replayMessages: [], inputHistory: [] }
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

beforeEach(() => {
	prompt.reset()
})

afterEach(() => {
	prompt.reset()
})

function makeBootstrap(sessionId: string, pendingQuestion?: { id: string; text: string }): BootstrapState {
	const ts = new Date().toISOString()
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: [sessionId],
		activeSessionId: sessionId,
		busySessionIds: pendingQuestion ? [sessionId] : [],
		eventsOffset: 0,
		updatedAt: ts,
		pendingQuestions: pendingQuestion ? { [sessionId]: pendingQuestion } : {},
	}
	const sessions: SessionInfo[] = [{ id: sessionId, workingDir: process.cwd(), createdAt: ts, updatedAt: ts }]
	return { state, sessions }
}

test('startup restores pending question from runtime state', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const pendingQuestion = { id: 'q-1', text: 'Tabs or spaces?' }
	const transport = new FakeTransport(makeBootstrap(sessionId, pendingQuestion))
	const client = new Client(transport, () => {})

	await client.start()

	expect(client.activeTab()?.question).toEqual(pendingQuestion)
})

test('answer event clears restored question', async () => {
	const sessionId = `t-${randomBytes(4).toString('hex')}`
	const pendingQuestion = { id: 'q-1', text: 'Tabs or spaces?' }
	const ts = new Date().toISOString()
	const answerEvent: RuntimeEvent = {
		id: 'e-answer',
		type: 'answer',
		sessionId,
		question: pendingQuestion.text,
		text: 'tabs',
		createdAt: ts,
	}
	const transport = new FakeTransport(makeBootstrap(sessionId, pendingQuestion), [answerEvent])
	const client = new Client(transport, () => {})

	await client.start()

	const tab = client.activeTab()
	expect(tab?.question).toBeUndefined()
	expect(tab?.blocks.some(b => b.type === 'input' && b.text === pendingQuestion.text)).toBe(true)
	expect(tab?.blocks.some(b => b.type === 'input' && b.text === 'tabs')).toBe(true)
})
