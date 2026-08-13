import { liveEventBlocks, type LiveEvent } from './live-event-blocks.ts'
import type { SharedState } from './ipc.ts'
import type { ClientSessionSnapshot } from './snapshots.ts'

export interface WebSubscribeMessage {
	type: 'subscribe'
	sessionId: string
}

export type WebClientMessage = WebSubscribeMessage

export type WebServerMessage =
	| { type: 'state'; state: SharedState }
	| { type: 'snapshot'; snapshot: ClientSessionSnapshot }
	| { type: 'event'; event: LiveEvent }

function applySessionMessage(snapshot: ClientSessionSnapshot | null, message: WebServerMessage): ClientSessionSnapshot | null {
	if (message.type === 'snapshot') return message.snapshot
	if (message.type !== 'event' || !snapshot || message.event.sessionId !== snapshot.session.id) return snapshot
	const result = liveEventBlocks.reduce(snapshot.live, message.event, {
		sessionId: snapshot.session.id,
		defaultModel: snapshot.session.model,
	})
	if (!result.changed) return snapshot
	return { ...snapshot, live: result.blocks }
}

export const webMessages = { applySessionMessage }
