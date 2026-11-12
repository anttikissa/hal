/// <reference lib="dom" />
// Attachments from the message box (task zc): an image pasted, an
// image or text file dropped anywhere on the page or picked with the
// attach button (task n5), and pasted text longer than
// settings.pasteLines(). Each puts its placeholder at the caret through
// `insert` at once and sends its bytes when read; the host's answer
// turns the placeholder into the marker (common/uploads.ts, app.settled).

import { attachments } from '../common/attachments.ts'
import { connection } from '../common/connection.ts'
import { prompt } from '../common/prompt.ts'
import { uploads } from '../common/uploads.ts'
import { app } from './app.ts'

type Insert = (text: string) => void
// What a paste event's clipboardData offers.
export type Pasted = {
	items?: ArrayLike<{ kind: string; type: string; getAsFile(): Blob | null }>
	getData(type: string): string
}

// Starts uploading `blob` for the session shown; `from`: its file name.
// An image over the size limit is shrunk to a JPEG that fits.
function blob(b: Blob, mediaType: string, insert: Insert, from = ''): void {
	let id = app.sessionId()
	if (!id) return
	let shrink = mediaType.startsWith('image/') && b.size > attachments.maxBytes
	if (shrink) mediaType = 'image/jpeg'
	let big = shrink ? undefined : uploads.tooBig(b.size)
	if (big) return app.setNotice(from ? `${from}: ${big}` : big)
	let command = connection.nextId()
	insert(uploads.begin(id, command, mediaType, from))
	;(shrink ? attach.fit(b) : Promise.resolve(b))
		.then((b) => b.arrayBuffer())
		.then(
			(bytes) => connection.send(uploads.command(id, command, mediaType, new Uint8Array(bytes))),
			(e) =>
				app.onEvent({ type: 'rejected', sessionId: id, command: 'attach', reason: String(e?.message ?? e), id: command }),
		)
}

// `image` as a JPEG within attachments.maxBytes: its long edge at most
// 2576 px (Opus downscales to that anyway), smaller until it fits.
async function fit(image: Blob): Promise<Blob> {
	let bitmap = await createImageBitmap(image)
	for (let edge = 2576; ; edge = Math.round(edge * 0.7)) {
		let scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
		let canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
		let g = canvas.getContext('2d')!
		g.fillStyle = '#fff' // JPEG has no alpha; transparency becomes white, not black.
		g.fillRect(0, 0, canvas.width, canvas.height)
		g.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
		let out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
		if (out.size <= attachments.maxBytes) return out
	}
}

// What the file picker offers.
const accept = '' // The picker offers every file type.

// How `file` is attached (common attachments.fileKind).
const kind = (file: { name: string; type: string }): string | undefined => attachments.fileKind(file.name, file.type)

// Files dropped or picked are uploaded at the caret in order.
function files(list: ArrayLike<File>, insert: Insert): void {
	for (let f of Array.from(list)) attach.blob(f, attach.kind(f) ?? 'application/octet-stream', insert, f.name)
}

// A paste into the box: true if taken here (the first image, or a long
// text), so the caller stops the browser's own paste.
function paste(data: Pasted, insert: Insert): boolean {
	if (!app.sessionId()) return false
	let item = Array.from(data.items ?? []).find((i) => i.kind === 'file')
	let file = item?.getAsFile()
	if (file) {
		let name =
			'name' in file && typeof file.name === 'string' ? file.name : `attachment.${item!.type.split('/')[1] ?? 'bin'}`
		attach.blob(file, attachments.fileKind(name, item!.type) ?? 'application/octet-stream', insert, name)
		return true
	}
	let text = prompt.clean(data.getData('text/plain'))
	if (!uploads.long(text)) return false
	attach.blob(new Blob([text]), 'text/plain', insert)
	return true
}

export const attach = { accept, kind, blob, fit, files, paste }
