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

// Text files by extension: browsers type many of them oddly or not at
// all (macOS Chrome calls .ts video/mp2t, most give .md and .toml '').
const textExts = new Set(
	'txt md markdown json jsonc json5 ason asonl ndjson csv tsv log xml svg html htm css scss less js mjs cjs jsx ts mts cts tsx py rb go rs c h cc cpp hpp java kt swift sh bash zsh fish yaml yml toml ini cfg conf env sql graphql lua pl php r diff patch tex rst org'.split(' '),
)
const textTypes = /^(?:text\/|application\/(?:json|xml|javascript|x-sh|x-yaml|yaml|toml|sql|x-httpd-php)\b)/
// What the file picker offers.
const accept = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/*', ...[...textExts].map((e) => `.${e}`)].join(',')

// How `file` is attached: the image's media type, 'text/plain', or
// undefined when it is neither (a PDF, a zip) and is refused.
function kind(file: { name: string; type: string }): string | undefined {
	if (attachments.types[file.type] && file.type.startsWith('image/')) return file.type
	let ext = /\.([^./]+)$/.exec(file.name)?.[1]?.toLowerCase()
	if ((ext && textExts.has(ext)) || textTypes.test(file.type)) return 'text/plain'
	// No extension and no type: README, Makefile, LICENSE.
	return !ext && !file.type ? 'text/plain' : undefined
}

// Files dropped or picked: each image or text file becomes a marker at
// the caret, in order; the rest are named in a notice and not sent.
function files(list: ArrayLike<File>, insert: Insert): void {
	let refused: string[] = []
	for (let f of Array.from(list)) {
		let type = attach.kind(f)
		if (type) attach.blob(f, type, insert)
		else refused.push(f.name)
	}
	if (refused.length) app.setNotice(`not attached (neither image nor text): ${refused.join(', ')}`)
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

export const attach = { accept, kind, blob, files, paste }
