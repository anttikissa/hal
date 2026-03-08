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
	tailEvents(fromOffset?: number): { items: AsyncGenerator<RuntimeEvent>; cancel(): void }
	replaySession(id: string): Promise<Message[]>
	eventsOffset(): Promise<number>
}

// ── Local transport (file-backed IPC) ──

import { commands, events, getState } from '../ipc.ts'
import { loadMeta } from '../session/session.ts'
import { readMessages } from '../session/messages.ts'

export class LocalTransport implements Transport {
	async sendCommand(cmd: RuntimeCommand): Promise<void> {
		await commands.append(cmd)
	}

	async bootstrap(): Promise<BootstrapState> {
		const state = getState()
		const sessions: SessionInfo[] = []
		for (const id of state.sessions) {
			const meta = await loadMeta(id)
			if (meta) sessions.push(meta)
		}
		return { state, sessions }
	}

	tailEvents(fromOffset?: number) {
		return events.tail(fromOffset)
	}

	async replaySession(id: string): Promise<Message[]> {
		return readMessages(id)
	}

	async eventsOffset(): Promise<number> {
		return events.offset()
	}
}
