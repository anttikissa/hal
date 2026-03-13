// Transport interface + local (file-backed) implementation.

import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from '../protocol.ts'
import type { HydrationData } from '../session/history.ts'
import { ipc } from '../ipc.ts'
import { session } from '../session/session.ts'
import { history } from '../session/history.ts'

// ── Interface ──

export interface BootstrapState {
	state: RuntimeState
	sessions: SessionInfo[]
}

export interface Transport {
	sendCommand(cmd: RuntimeCommand): Promise<void>
	bootstrap(): Promise<BootstrapState>
	tailEvents(fromOffset?: number): { items: AsyncGenerator<RuntimeEvent>; cancel(): void }
	hydrateSession(id: string): Promise<HydrationData>
	eventsOffset(): Promise<number>
}

// ── Local transport (file-backed IPC) ──

export class LocalTransport implements Transport {
	async sendCommand(cmd: RuntimeCommand): Promise<void> {
		await ipc.commands.append(cmd)
	}

	async bootstrap(): Promise<BootstrapState> {
		const state = ipc.getState()
		const sessions: SessionInfo[] = []
		for (const id of state.sessions) {
			const meta = await session.loadSessionInfo(id)
			if (meta) sessions.push(meta)
		}
		return { state, sessions }
	}

	tailEvents(fromOffset?: number) {
		return ipc.events.tail(fromOffset)
	}

	async hydrateSession(id: string): Promise<HydrationData> {
		return history.loadHydrationData(id)
	}

	async eventsOffset(): Promise<number> {
		return ipc.events.offset()
	}
}
