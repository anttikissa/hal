// Attachments a client sent (task 2a), stored per session as
// sessions/<id>/blobs/<blob>.<ext>, and resolved in prompt text.
// A pasted image or long text (tasks qy, 31) waits by its client-chosen
// name in paths.fileDir(name) and is copied into a blob of the session
// whose prompt names it with [image/<name>] or [paste/<name>]; that
// blob then outlives /tmp.
//
// Only blobs the host stored for that session resolve: a blob id is
// checked against its fixed form before it names a file, and is looked
// up only in that session's directory, so nothing from a client ever
// becomes a path of its own. History holds references (ImageBlock),
// never the bytes; providers read them through base64() per request.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { attachments, type Marker } from '../common/attachments.ts'
import type { ImageBlock, UserBlock } from '../common/blocks.ts'
import { paths } from './paths.ts'

export type Stored = { blob: string; mediaType: string; bytes: number; marker: string }

function dir(sessionId: string): string {
	return `${paths.sessionDir(sessionId)}/blobs`
}

// Whether the bytes are what the media type says: an image's magic
// number, or text that is valid UTF-8.
function looksLike(mediaType: string, bytes: Uint8Array): boolean {
	let head = (s: string, at = 0) => [...s].every((c, i) => bytes[at + i] === c.charCodeAt(0))
	if (mediaType === 'image/png') return head('\x89PNG\r\n\x1a\n')
	if (mediaType === 'image/jpeg') return head('\xff\xd8\xff')
	if (mediaType === 'image/gif') return head('GIF8')
	if (mediaType === 'image/webp') return head('RIFF') && head('WEBP', 8)
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		return true
	} catch {
		return false
	}
}

// The bytes of an attachment's base64 `data`; throws why it is refused.
function decode(mediaType: string, data: string): Buffer {
	if (!attachments.types[mediaType]) throw new Error(`unsupported attachment type ${JSON.stringify(mediaType)}; expected png, jpeg, gif, webp or text/plain`)
	let max = attachments.maxBytes()
	// Checked before decoding: base64 is 4 characters per 3 bytes.
	if (data.length > Math.ceil(max / 3) * 4) throw new Error(`attachment larger than ${max / 1024 / 1024} MB`)
	if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('attachment data is not base64')
	let bytes = Buffer.from(data, 'base64')
	if (!bytes.length) throw new Error('attachment is empty')
	if (bytes.length > max) throw new Error(`attachment larger than ${max / 1024 / 1024} MB`)
	if (!blobs.looksLike(mediaType, bytes)) throw new Error(`attachment is not ${mediaType}`)
	return bytes
}

// Checks and stores one attachment; throws the reason it is refused.
function store(sessionId: string, mediaType: string, data: string): Stored {
	let bytes = blobs.decode(mediaType, data)
	let ext = attachments.types[mediaType]!
	mkdirSync(blobs.dir(sessionId), { recursive: true })
	let blob: string
	do blob = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('hex')
	while (blobs.find(sessionId, blob))
	writeFileSync(`${blobs.dir(sessionId)}/${blob}.${ext}`, bytes, { mode: 0o600 })
	let lines = mediaType === 'text/plain' ? bytes.toString('utf8').replace(/\n$/, '').split('\n').length : 0
	return { blob, mediaType, bytes: bytes.length, marker: attachments.marker(blob, mediaType, lines) }
}

// Checks a pasted image or text and keeps it as
// paths.fileDir(name)/<name>; throws why it is refused. The same bytes
// again (a resend) are fine; other bytes under a taken name are not.
function stage(name: string, mediaType: string, data: string): Stored {
	if (attachments.nameType(name) !== mediaType) throw new Error(`file name ${JSON.stringify(name)} does not fit ${mediaType}`)
	let bytes = blobs.decode(mediaType, data)
	let path = `${paths.fileDir(name)}/${name}`
	if (existsSync(path)) {
		if (!bytes.equals(readFileSync(path))) throw new Error(`file name ${name} is taken`)
	} else {
		mkdirSync(paths.fileDir(name), { recursive: true, mode: 0o700 })
		writeFileSync(path, bytes, { mode: 0o600 })
	}
	return { blob: name.slice(0, 6), mediaType, bytes: bytes.length, marker: attachments.named(name) }
}

// Pasted file `name` still in paths.fileDir(name), if its bytes are
// what its name says and not too large.
function staged(name: string): { bytes: Buffer; mediaType: string } | undefined {
	let mediaType = attachments.nameType(name)
	if (!mediaType) return undefined
	let path = `${paths.fileDir(name)}/${name}`
	if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return undefined
	let bytes = readFileSync(path)
	return bytes.length <= attachments.maxBytes() && blobs.looksLike(mediaType, bytes) ? { bytes, mediaType } : undefined
}

// Pasted file `name` for the web (/image/<name>, /paste/<name>): its
// bytes, from paths.fileDir(name) or once /tmp is cleaned from a
// session blob a prompt copied it into, and where it lives on disk:
// `tmp` if still there, `blobs` for each session copy.
function file(name: string): { bytes: Buffer; mediaType: string; tmp?: string; blobs: string[] } | undefined {
	let mediaType = attachments.nameType(name)
	if (!mediaType) return undefined
	let dirs = existsSync(paths.sessionsDir()) ? readdirSync(paths.sessionsDir()) : []
	let copies = dirs.map((d) => `${paths.sessionsDir()}/${d}/blobs/${name}`).filter((p) => existsSync(p))
	let found = blobs.staged(name)
	if (found) return { ...found, tmp: `${paths.fileDir(name)}/${name}`, blobs: copies }
	return copies.length ? { bytes: readFileSync(copies[0]!), mediaType, blobs: copies } : undefined
}

// The session's blob with this exact id: its file and media type.
function find(sessionId: string, blob: string): { path: string; mediaType: string } | undefined {
	if (!attachments.blobId.test(blob)) return undefined
	for (let [mediaType, ext] of Object.entries(attachments.types)) {
		let path = `${blobs.dir(sessionId)}/${blob}.${ext}`
		if (existsSync(path)) return { path, mediaType }
	}
	return undefined
}

function read(sessionId: string, blob: string): { bytes: Buffer; mediaType: string } | undefined {
	let found = blobs.find(sessionId, blob)
	return found && { bytes: readFileSync(found.path), mediaType: found.mediaType }
}

// An image's bytes as base64, for a provider request.
function base64(sessionId: string, blob: string): string | undefined {
	return blobs.read(sessionId, blob)?.bytes.toString('base64')
}

// The blob a marker names, if it is this session's and of its kind. A
// pasted file's is copied from paths.fileDir() on first use.
function named(sessionId: string, m: Marker): { path: string; mediaType: string } | undefined {
	let found = blobs.find(sessionId, m.blob)
	if (m.file) {
		let mediaType = attachments.nameType(m.file)
		if (found) return found.mediaType === mediaType ? found : undefined
		let fresh = blobs.staged(m.file)
		if (!fresh) return undefined
		mkdirSync(blobs.dir(sessionId), { recursive: true })
		let path = `${blobs.dir(sessionId)}/${m.file}`
		writeFileSync(path, fresh.bytes, { mode: 0o600 })
		return { path, mediaType: fresh.mediaType }
	}
	return found && (found.mediaType === 'text/plain') === (m.kind === 'paste') ? found : undefined
}

// The markers in `text` that name no blob of the session.
function unknown(sessionId: string, text: string): string[] {
	return attachments.markers(text).flatMap((m) => (blobs.named(sessionId, m) ? [] : [m.text]))
}

// Prompt texts as user blocks: each paste marker replaced by its text,
// then one image block per image marker (each blob once). Markers that
// name no blob of this session (or the wrong kind) stay text and are
// listed in `unknown`. Image markers stay in the text, so the model can
// tell which image the words are about.
function resolve(sessionId: string, texts: string[]): { blocks: UserBlock[]; unknown: string[] } {
	let images: ImageBlock[] = []
	let unknown: string[] = []
	let out = texts.map((text) => {
		let parts: string[] = []
		let from = 0
		for (let m of attachments.markers(text)) {
			let found = blobs.named(sessionId, m)
			if (!found) unknown.push(m.text)
			else if (m.kind === 'image') {
				if (!images.some((b) => b.blob === m.blob)) images.push({ type: 'image', blob: m.blob, mediaType: found.mediaType, bytes: statSync(found.path).size })
			} else {
				parts.push(text.slice(from, m.at), readFileSync(found.path, 'utf8'))
				from = m.at + m.text.length
			}
		}
		parts.push(text.slice(from))
		return { type: 'text' as const, text: parts.join('') }
	})
	return { blocks: [...out, ...images], unknown }
}

export const blobs = { dir, looksLike, decode, store, stage, staged, file, find, read, base64, named, unknown, resolve }
