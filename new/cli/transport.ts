// Transport interface + local (file-backed) implementation.

import type { RuntimeCommand, RuntimeEvent, RuntimeState, SessionInfo } from '../protocol.ts'
import type { Message } from '../session/messages.ts'

// ── Interface ──

export interface BootstrapState {
	state: RuntimeState
	sessions: SessionInfo[]
}

export interface Transport {
	sendCommand(cmd: RuntimeCommand): Promise<void>
	bootstrap(): Promise<BootstrapState>
	tailEvents(fromOffset: number): AsyncGenerator<RuntimeEvent>
	replaySession(id: string): Promise<Message[]>
	eventsOffset(): Promise<number>
}

// ── Local transport (file-backed IPC) ──

import * as ipc from '../ipc.ts'
import { loadMeta } from '../session/session.ts'
import { readMessages } from '../session/messages.ts'

export class LocalTransport implements Transport {
	async sendCommand(cmd: RuntimeCommand): Promise<void> {
		await ipc.appendCommand(cmd)
	}

	async bootstrap(): Promise<BootstrapState> {
		const state = ipc.getState()
		const sessions: SessionInfo[] = []
		for (const id of state.sessions) {
			const meta = await loadMeta(id)
			if (meta) sessions.push(meta)
		}
		return { state, sessions }
	}

	tailEvents(fromOffset: number): AsyncGenerator<RuntimeEvent> {
		return ipc.tailEventsFrom(fromOffset)
	}

	async replaySession(id: string): Promise<Message[]> {
		return readMessages(id)
	}

	async eventsOffset(): Promise<number> {
		return ipc.eventsOffset()
	}
}
