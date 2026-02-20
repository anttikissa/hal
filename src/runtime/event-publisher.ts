import { shortenHome } from "../tools.ts"
import { appendEvent, updateState } from "../ipc.ts"
import type { EventLevel, RuntimeEvent, RuntimeSource, SessionInfo } from "../protocol.ts"
import { stringify } from "../utils/ason.ts"

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

let ownerId: string
let eventCounter = 0
let lastStatus = ""
let lastSessionsKey = ""

function eventId(): string {
	eventCounter += 1
	return `${Date.now()}-${process.pid}-${eventCounter}`
}

export function initPublisher(owner: string): void {
	ownerId = owner
}

type EventPayload =
	| Omit<Extract<RuntimeEvent, { type: "line" }>, "id" | "createdAt">
	| Omit<Extract<RuntimeEvent, { type: "chunk" }>, "id" | "createdAt">
	| Omit<Extract<RuntimeEvent, { type: "status" }>, "id" | "createdAt">
	| Omit<Extract<RuntimeEvent, { type: "sessions" }>, "id" | "createdAt">
	| Omit<Extract<RuntimeEvent, { type: "command" }>, "id" | "createdAt">
	| Omit<Extract<RuntimeEvent, { type: "prompt" }>, "id" | "createdAt">

async function emit(payload: EventPayload): Promise<void> {
	const event = {
		...payload,
		createdAt: new Date().toISOString(),
		id: eventId(),
	} as RuntimeEvent
	await appendEvent(event)
}

export async function publishLine(
	text: string,
	level: EventLevel,
	sessionId: string | null,
): Promise<void> {
	await emit({
		type: "line",
		sessionId,
		text: shortenHome(text.replace(ANSI_PATTERN, "")),
		level,
	})
}

export async function publishChunk(
	text: string,
	channel: "assistant" | "thinking",
	sessionId: string | null,
): Promise<void> {
	await emit({ type: "chunk", sessionId, text, channel })
}

export async function publishCommandPhase(
	commandId: string,
	phase: "queued" | "started" | "done" | "failed",
	message: string | undefined,
	sessionId: string | null,
): Promise<void> {
	await emit({ type: "command", sessionId, commandId, phase, message })
}

export async function publishPrompt(
	sessionId: string | null,
	text: string,
	source: RuntimeSource,
): Promise<void> {
	await emit({ type: "prompt", sessionId, text, source })
}

export interface StatusSnapshot {
	busySessionIds: string[]
	activeSessionId: string | null
	registryActiveSessionId: string | null
	queueLength: number
	sessions: SessionInfo[]
}

export async function publishStatus(snapshot: StatusSnapshot, force = false): Promise<void> {
	const { busySessionIds, activeSessionId, registryActiveSessionId, queueLength, sessions } = snapshot
	const busy = busySessionIds.length > 0
	const effectiveActiveId = registryActiveSessionId ?? activeSessionId
	const key = `${busy}:${queueLength}:${busySessionIds.join(",")}:${effectiveActiveId ?? "-"}`
	if (!force && key === lastStatus) return
	lastStatus = key

	await updateState((state) => {
		if (state.ownerId === ownerId) {
			state.busy = busy
			state.queueLength = queueLength
			state.busySessionIds = busySessionIds
			state.activeSessionId = effectiveActiveId ?? null
			state.sessions = sessions
		}
	})

	await emit({
		type: "status",
		sessionId: busySessionIds[0] ?? null,
		busySessionIds,
		activeSessionId: effectiveActiveId ?? null,
		busy,
		queueLength,
	})
}

export async function publishSessions(
	activeSessionId: string | null,
	registryActiveSessionId: string | null,
	sessions: SessionInfo[],
	force = false,
): Promise<void> {
	const effectiveActiveId = registryActiveSessionId ?? activeSessionId
	const key = stringify({
		activeSessionId: effectiveActiveId,
		sessions: sessions.map((s) => ({
			id: s.id, workingDir: s.workingDir, messageCount: s.messageCount,
			busy: s.busy, updatedAt: s.updatedAt,
		})),
	})
	if (!force && key === lastSessionsKey) return
	lastSessionsKey = key
	await emit({ type: "sessions", activeSessionId: effectiveActiveId ?? null, sessions })
}
