/// <reference lib="dom" />
// Attachments from the message box (task zc): an image pasted, dropped
// or picked with the attach button, and pasted text longer than
// settings.pasteLines(). Each puts its placeholder at the caret through
// `insert` at once and sends its bytes when read; the host's answer
// turns the placeholder into the marker (common/uploads.ts, app.settled).

import { connection } from '../common/connection.ts'
import { prompt } from '../common/prompt.ts'
import { uploads } from '../common/uploads.ts'
import { app } from './app.ts'

type Insert = (text: string) => void
// What a paste event's clipboardData offers.
export type Pasted = { items?: ArrayLike<{ kind: string; type: string; getAsFile(): Blob | null }>; getData(type: string): string }

// Starts uploading `blob` for the session shown.
function blob(b: Blob, mediaType: string, insert: Insert): void {
	let id = app.sessionId()
	if (!id) return
	let big = uploads.tooBig(b.size)
	if (big) return insert(big)
	let command = connection.nextId()
	insert(uploads.begin(id, command, mediaType))
	b.arrayBuffer().then(
		(bytes) => connection.send(uploads.command(id, command, mediaType, new Uint8Array(bytes))),
		(e) => app.onEvent({ type: 'rejected', sessionId: id, command: 'attach', reason: String(e?.message ?? e), id: command }),
	)
}

// Images among `files` (a drop or the file picker); true if any.
function files(list: ArrayLike<Blob>, insert: Insert): boolean {
	let images = Array.from(list).filter((f) => f.type.startsWith('image/'))
	for (let f of images) attach.blob(f, f.type, insert)
	return images.length > 0
}

// A paste into the box: true if taken here (the first image, or a long
// text), so the caller stops the browser's own paste.
function paste(data: Pasted, insert: Insert): boolean {
	if (!app.sessionId()) return false
	let item = Array.from(data.items ?? []).find((i) => i.kind === 'file' && i.type.startsWith('image/'))
	let image = item?.getAsFile()
	if (item && image) return (attach.blob(image, item.type, insert), true)
	let text = prompt.clean(data.getData('text/plain'))
	if (!uploads.long(text)) return false
	attach.blob(new Blob([text]), 'text/plain', insert)
	return true
}

export const attach = { blob, files, paste }
