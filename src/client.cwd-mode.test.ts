import { test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { Client } from './client.ts'
import type { Transport, BootstrapState } from './cli/transport.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from './protocol.ts'
import type { HydrationData } from './session/history.ts'
import { clientState } from './client-state.ts'

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

test('cwd mode switches to tab matching LAUNCH_CWD', async () => {
	const origCwd = process.env.LAUNCH_CWD
	const origSelf = process.env.HAL_SELF_MODE
	process.env.LAUNCH_CWD = '/tmp/my-project'
	delete process.env.HAL_SELF_MODE
	try {
		const ts = new Date().toISOString()
		const sidA = `t-${randomBytes(4).toString('hex')}`
		const sidB = `t-${randomBytes(4).toString('hex')}`
		const sessions: SessionInfo[] = [
			{ id: sidA, workingDir: process.cwd(), createdAt: ts, updatedAt: ts },
			{ id: sidB, workingDir: '/tmp/my-project', createdAt: ts, updatedAt: ts },
		]
		const transport = new FakeTransport(bootstrapWith(sessions, sidA))
		const client = new Client(transport, () => {})
		await client.start()
		expect(client.activeTab()?.sessionId).toBe(sidB)
		expect(transport.sentCommands.some(c => c.type === 'open')).toBe(false)
	} finally {
		if (origCwd == null) delete process.env.LAUNCH_CWD
		else process.env.LAUNCH_CWD = origCwd
		if (origSelf == null) delete process.env.HAL_SELF_MODE
		else process.env.HAL_SELF_MODE = origSelf
	}
})

test('cwd mode does not override restored last tab', async () => {
	const origCwd = process.env.LAUNCH_CWD
	const origSelf = process.env.HAL_SELF_MODE
	const origGetLastTab = clientState.getLastTab
	const origSaveLastTab = clientState.saveLastTab
	process.env.LAUNCH_CWD = '/tmp/my-project'
	delete process.env.HAL_SELF_MODE
	try {
		const ts = new Date().toISOString()
		const sidA = `t-${randomBytes(4).toString('hex')}`
		const sidB = `t-${randomBytes(4).toString('hex')}`
		const sessions: SessionInfo[] = [
			{ id: sidA, workingDir: process.cwd(), createdAt: ts, updatedAt: ts },
			{ id: sidB, workingDir: '/tmp/my-project', createdAt: ts, updatedAt: ts },
		]
		;(clientState as { getLastTab: () => string | null; saveLastTab: (sessionId: string) => void }).getLastTab = () => sidA
		;(clientState as { getLastTab: () => string | null; saveLastTab: (sessionId: string) => void }).saveLastTab = () => {}
		const transport = new FakeTransport(bootstrapWith(sessions, sidB))
		const client = new Client(transport, () => {})
		await client.start()
		expect(client.activeTab()?.sessionId).toBe(sidA)
		expect(transport.sentCommands.some(c => c.type === 'open')).toBe(false)
	} finally {
		if (origCwd == null) delete process.env.LAUNCH_CWD
		else process.env.LAUNCH_CWD = origCwd
		if (origSelf == null) delete process.env.HAL_SELF_MODE
		else process.env.HAL_SELF_MODE = origSelf
		;(clientState as { getLastTab: () => string | null; saveLastTab: (sessionId: string) => void }).getLastTab = origGetLastTab
		;(clientState as { getLastTab: () => string | null; saveLastTab: (sessionId: string) => void }).saveLastTab = origSaveLastTab
	}
})
test('cwd mode opens new tab with matching workingDir when no match exists', async () => {
	const origCwd = process.env.LAUNCH_CWD
	const origSelf = process.env.HAL_SELF_MODE
	process.env.LAUNCH_CWD = '/tmp/no-such-project'
	delete process.env.HAL_SELF_MODE
	try {
		const ts = new Date().toISOString()
		const sidA = `t-${randomBytes(4).toString('hex')}`
		const sessions: SessionInfo[] = [
			{ id: sidA, workingDir: process.cwd(), createdAt: ts, updatedAt: ts },
		]
		const transport = new FakeTransport(bootstrapWith(sessions, sidA))
		const client = new Client(transport, () => {})
		await client.start()
		await Bun.sleep(10)
		const openCmd = transport.sentCommands.find(c => c.type === 'open')
		expect(openCmd).toBeTruthy()
		expect(openCmd!.workingDir).toBe('/tmp/no-such-project')
	} finally {
		if (origCwd == null) delete process.env.LAUNCH_CWD
		else process.env.LAUNCH_CWD = origCwd
		if (origSelf == null) delete process.env.HAL_SELF_MODE
		else process.env.HAL_SELF_MODE = origSelf
	}
})

test('cwd mode does not activate when LAUNCH_CWD equals HAL_DIR', async () => {
	const origCwd = process.env.LAUNCH_CWD
	const origSelf = process.env.HAL_SELF_MODE
	const origHalDir = process.env.HAL_DIR
	// Set LAUNCH_CWD = HAL_DIR to simulate being in hal dir
	process.env.LAUNCH_CWD = process.env.HAL_DIR
	delete process.env.HAL_SELF_MODE
	try {
		const ts = new Date().toISOString()
		const sidA = `t-${randomBytes(4).toString('hex')}`
		const sidB = `t-${randomBytes(4).toString('hex')}`
		const sessions: SessionInfo[] = [
			{ id: sidA, workingDir: '/tmp/other', createdAt: ts, updatedAt: ts },
			{ id: sidB, workingDir: '/tmp/other2', createdAt: ts, updatedAt: ts },
		]
		const transport = new FakeTransport(bootstrapWith(sessions, sidA))
		const client = new Client(transport, () => {})
		await client.start()
		// Should stay on sidA (server's active), not try to match cwd
		expect(client.activeTab()?.sessionId).toBe(sidA)
		expect(transport.sentCommands.some(c => c.type === 'open')).toBe(false)
	} finally {
		if (origCwd == null) delete process.env.LAUNCH_CWD
		else process.env.LAUNCH_CWD = origCwd
		if (origSelf == null) delete process.env.HAL_SELF_MODE
		else process.env.HAL_SELF_MODE = origSelf
		if (origHalDir == null) delete process.env.HAL_DIR
		else process.env.HAL_DIR = origHalDir
	}
})
