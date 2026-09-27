// Attachments on their way to the host (task zc), for terminal and web
// alike. Starting one puts a placeholder in the prompt that names the
// attach command's id, so it is found wherever typing has moved it, even
// if the user typed the same words; the host's `attached` answer turns it
// into the marker, a refusal into an error text. A submit while a
// session has uploads pending waits and goes when the last one lands.

import { attachments } from './attachments.ts'
import type { Event } from './protocol.ts'
import { settings } from './settings.ts'

type Upload = { sessionId: string; placeholder: string }
export type Settled = Upload & { text: string; error?: string; resume?: { queue: boolean } }
type Spot = { text: string; cursor: number; anchor?: number }

function createState() {
	// `pending`: by attach command id; `waiting`: sessions whose submit
	// waits for their uploads, and whether it queues.
	return { pending: new Map<string, Upload>(), waiting: new Map<string, boolean>() }
}

// Registers upload `id` (the attach command's id) of session
// `sessionId`: the placeholder that stands for it until the host answers.
function begin(sessionId: string, id: string, mediaType: string): string {
	let placeholder = `[uploading ${mediaType === 'text/plain' ? 'paste' : 'image'} ${id}]`
	uploads.state.pending.set(id, { sessionId, placeholder })
	return placeholder
}

// The attach command carrying `bytes`.
function command(sessionId: string, id: string, mediaType: string, bytes: Uint8Array): object {
	return { type: 'attach', id, sessionId, mediaType, data: uploads.base64(bytes) }
}

// The error text for something too large to send (the host would refuse
// it, and one message that big may break the connection), or undefined.
function tooBig(size: number): string | undefined {
	let max = attachments.maxBytes()
	return size > max ? `[upload failed: larger than ${max / 1024 / 1024} MB]` : undefined
}

function pending(sessionId: string): boolean {
	return [...uploads.state.pending.values()].some((u) => u.sessionId === sessionId)
}

// Enter while `sessionId` uploads: remembered, sent by the last settle.
function wait(sessionId: string, queue = false): void {
	uploads.state.waiting.set(sessionId, queue)
}

// The upload `event` answers, if any: what its placeholder becomes, and
// `resume` when a waiting submit may now go. A failure drops the wait.
function settle(event: Event): Settled | undefined {
	let id = event.type === 'attached' ? event.command : event.type === 'rejected' ? event.id : undefined
	let up = id === undefined ? undefined : uploads.state.pending.get(id)
	if (!up) return undefined
	uploads.state.pending.delete(id!)
	let st = uploads.state
	if (event.type === 'rejected') {
		st.waiting.delete(up.sessionId)
		return { ...up, text: `[upload failed: ${event.reason}]`, error: event.reason }
	}
	let done: Settled = { ...up, text: (event as Event & { type: 'attached' }).marker }
	let queue = st.waiting.get(up.sessionId)
	if (queue !== undefined && !uploads.pending(up.sessionId)) {
		st.waiting.delete(up.sessionId)
		done.resume = { queue }
	}
	return done
}

// `p` with the first `from` replaced by `to`; the caret and the
// selection's other end keep their place in the text around it.
function swap<P extends Spot>(p: P, from: string, to: string): P {
	let at = p.text.indexOf(from)
	if (at < 0) return p
	let move = (n: number) => (n <= at ? n : n >= at + from.length ? n + to.length - from.length : at + to.length)
	let out = { ...p, text: p.text.slice(0, at) + to + p.text.slice(at + from.length), cursor: move(p.cursor) }
	if (p.anchor !== undefined) out.anchor = move(p.anchor)
	return out
}

// A paste this long (after cleaning) becomes a text attachment.
function long(text: string): boolean {
	return text.split('\n').length > settings.pasteLines()
}

// Base64 of `bytes`, in chunks small enough for String.fromCharCode.
function base64(bytes: Uint8Array): string {
	let out = ''
	for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return btoa(out)
}

function reset(): void {
	uploads.state = createState()
}

export const uploads = { state: createState(), begin, command, tooBig, pending, wait, settle, swap, long, base64, reset }
