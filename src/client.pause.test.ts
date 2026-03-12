import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './cli/transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from './protocol.ts'
import type { Message, HydrationData } from './session/history.ts'
import { eventId } from './protocol.ts'

// Controllable transport: events are pushed manually, tail yields them via a promise queue.
class FakeTransport implements Transport {
	private bootstrapState: BootstrapState
	private replayMessages: Message[]
	private allEvents: RuntimeEvent[] = []
	private waiters: ((event: RuntimeEvent) => void)[] = []
	private pendingEvents: RuntimeEvent[] = []
	public sentCommands: RuntimeCommand[] = []

	constructor(bootstrapState: BootstrapState, replayMessages: Message[] = []) {
		this.bootstrapState = bootstrapState
		this.replayMessages = replayMessages
	}

	async sendCommand(cmd: RuntimeCommand): Promise<void> {
		this.sentCommands.push(cmd)
	}

	async bootstrap(): Promise<BootstrapState> {
		return this.bootstrapState
	}

	async hydrateSession(_id: string): Promise<HydrationData> {
		return { replayMessages: this.replayMessages, inputHistory: [] }
	}

	async eventsOffset(): Promise<number> {
		return this.allEvents.length
	}

	tailEvents(fromOffset?: number): { items: AsyncGenerator<RuntimeEvent>; cancel(): void } {
		const self = this
		let cancelled = false
		return {
			items: (async function* () {
				while (!cancelled) {
					if (self.pendingEvents.length > 0) {
						yield self.pendingEvents.shift()!
					} else {
						yield await new Promise<RuntimeEvent>(resolve => {
							self.waiters.push(resolve)
						})
					}
				}
			})(),
			cancel() { cancelled = true; self.waiters.forEach(w => w(null as any)) },
		}
	}

	pushEvent(event: RuntimeEvent): void {
		this.allEvents.push(event)
		const waiter = this.waiters.shift()
		if (waiter) waiter(event)
		else this.pendingEvents.push(event)
	}
}

const ts = new Date().toISOString()
const sessionId = `t-${randomBytes(4).toString('hex')}`

function makeBootstrap(busy: boolean): BootstrapState {
	const state: RuntimeState = {
		hostPid: 123,
		hostId: 'host-test',
		sessions: [sessionId],
		activeSessionId: sessionId,
		busySessionIds: busy ? [sessionId] : [],
		eventsOffset: 0,
		updatedAt: ts,
	}
	const sessions: SessionInfo[] = [
		{ id: sessionId, workingDir: process.cwd(), createdAt: ts, updatedAt: ts },
	]
	return { state, sessions }
}

async function startClient(busy: boolean, replayMessages: Message[] = []) {
	const transport = new FakeTransport(makeBootstrap(busy), replayMessages)
	let updates = 0
	const client = new Client(transport, () => { updates++ })
	void client.start()
	await Bun.sleep(50)
	return { client, transport, updates: () => updates }
}

test('pressing pause optimistically adds [pausing...] block and sets pausing flag', async () => {
	const { client, transport } = await startClient(true)
	const tab = client.activeTab()!

	// Simulate Esc: client sends pause + marks tab as pausing
	await client.send('pause')
	client.markPausing()

	expect(tab.pausing).toBe(true)
	const pausingBlock = tab.blocks.find(b => b.type === 'info' && b.text === '[pausing...]')
	expect(pausingBlock).toBeTruthy()
})

test('[paused] line event removes [pausing...] block and clears pausing flag', async () => {
	const { client, transport } = await startClient(true)
	const tab = client.activeTab()!

	client.markPausing()
	expect(tab.blocks.some(b => b.type === 'info' && b.text === '[pausing...]')).toBe(true)

	// Runtime sends [paused] line
	transport.pushEvent({
		id: eventId(), type: 'line', sessionId, text: '[paused]', level: 'meta', createdAt: ts,
	})
	await Bun.sleep(10)

	// [pausing...] should be gone, [paused] should be present
	expect(tab.blocks.some(b => b.type === 'info' && b.text === '[pausing...]')).toBe(false)
	expect(tab.blocks.some(b => b.type === 'info' && b.text === '[paused]')).toBe(true)
	expect(tab.pausing).toBe(false)
})

test('chunks arriving between [pausing...] and [paused] appear in output', async () => {
	const { client, transport } = await startClient(true)
	const tab = client.activeTab()!

	// Simulate some assistant content already streaming
	transport.pushEvent({
		id: eventId(), type: 'chunk', sessionId, text: 'hello ', channel: 'assistant', createdAt: ts,
	})
	await Bun.sleep(10)

	client.markPausing()

	// More chunks arrive while pausing
	transport.pushEvent({
		id: eventId(), type: 'chunk', sessionId, text: 'world', channel: 'assistant', createdAt: ts,
	})
	await Bun.sleep(10)

	// [paused] arrives
	transport.pushEvent({
		id: eventId(), type: 'line', sessionId, text: '[paused]', level: 'meta', createdAt: ts,
	})
	await Bun.sleep(10)

	// Should have assistant content + [paused], no [pausing...]
	const texts = tab.blocks.map(b => {
		if (b.type === 'assistant') return `assistant:${b.text}`
		if (b.type === 'info') return `info:${b.text}`
		return b.type
	})
	expect(texts.some(t => t.startsWith('assistant:') && t.includes('hello '))).toBe(true)
	expect(texts.some(t => t === 'info:[paused]')).toBe(true)
	expect(texts.some(t => t === 'info:[pausing...]')).toBe(false)
})

test('status event clears pausing when session is no longer busy', async () => {
	const { client, transport } = await startClient(true)
	const tab = client.activeTab()!

	client.markPausing()
	expect(tab.pausing).toBe(true)

	// Status with busy=false
	transport.pushEvent({
		id: eventId(), type: 'status', sessionId: null,
		busySessionIds: [], pausedSessionIds: [],
		activeSessionId: sessionId, busy: false, queueLength: 0,
		createdAt: ts,
	})
	await Bun.sleep(10)

	expect(tab.busy).toBe(false)
	expect(tab.pausing).toBe(false)
})
test('status busy clears stale /continue interrupt hint', async () => {
	const replayMessages: Message[] = [
		{ role: 'user', content: 'Resume me', ts } as any,
	]
	const { client, transport } = await startClient(false, replayMessages)
	const tab = client.activeTab()!
	expect(tab.blocks.some((b) => b.type === 'info' && b.text === '[interrupted] Type /continue to continue')).toBe(true)

	transport.pushEvent({
		id: eventId(), type: 'status', sessionId: null,
		busySessionIds: [sessionId], pausedSessionIds: [],
		activeSessionId: sessionId, busy: true, queueLength: 0,
		createdAt: ts,
	})
	await Bun.sleep(10)

	expect(tab.blocks.some((b) => b.type === 'info' && b.text === '[interrupted] Type /continue to continue')).toBe(false)
})
test('thinking block uses fallback model from session update when session model is unset', async () => {
	const { client, transport } = await startClient(true)
	const tab = client.activeTab()!

	transport.pushEvent({
		id: eventId(),
		type: 'sessions',
		activeSessionId: sessionId,
		sessions: [{ ...tab.info, model: 'openai/gpt-5.3-codex' }],
		createdAt: ts,
	})
	await Bun.sleep(10)

	transport.pushEvent({
		id: eventId(),
		type: 'chunk',
		sessionId,
		channel: 'thinking',
		text: Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n'),
		createdAt: ts,
	})
	await Bun.sleep(10)

	const thinking = tab.blocks.find((b): b is Extract<typeof b, { type: 'thinking' }> => b.type === 'thinking')
	expect(thinking).toBeTruthy()
	expect(thinking?.model).toBe('openai/gpt-5.3-codex')
})
