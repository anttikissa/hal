import type { SharedState } from './ipc.ts'
import type { Command } from './protocol.ts'
import type { ClientBootstrap, ClientSessionSnapshot } from './snapshots.ts'
import { ason } from '../utils/ason.ts'
import { liveEventBlocks } from './live-event-blocks.ts'

export interface WebAuthenticateMessage {
	type: 'authenticate'
	token: string
}

export interface WebCommandMessage {
	type: 'command'
	command: Command
}

export type WebClientMessage = WebAuthenticateMessage | WebCommandMessage

export type WebServerMessage =
	| { type: 'authenticated'; bootstrap: ClientBootstrap }
	| { type: 'error'; message: string }
	| { type: 'state'; state: SharedState }
	| { type: 'snapshot'; snapshot: ClientSessionSnapshot }
	| { type: 'event'; event: any }

function encode(message: WebClientMessage | WebServerMessage): string {
	return ason.stringify(message, 'short')
}

function decode(text: string): unknown {
	try {
		return ason.parse(text)
	} catch {
		return null
	}
}

function applySessionMessage(snapshot: ClientSessionSnapshot | null, message: WebServerMessage): ClientSessionSnapshot | null {
	if (message.type === 'snapshot') return message.snapshot
	if (message.type !== 'event' || !snapshot || message.event?.sessionId !== snapshot.session.id) return snapshot
	const result = liveEventBlocks.reduce(snapshot.live, message.event, {
		sessionId: snapshot.session.id,
		defaultModel: snapshot.session.model,
	})
	if (!result.changed) return snapshot
	return { ...snapshot, live: result.blocks }
}

export const webProtocol = { encode, decode, applySessionMessage }
