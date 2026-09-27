// Attachments in prompt text (task 2a): what a client may attach, the
// markers that name an attachment in a prompt, and how an image block
// reads in a transcript. Pure; the host stores and resolves them
// (src/host/blobs.ts).

import type { ImageBlock } from './blocks.ts'

// Media type -> the extension its blob is stored under.
const types: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'text/plain': 'txt',
}

// Blob ids: 12 random lowercase hex digits made by the host, or the
// 6 base36 characters of a pasted image's name (task qy).
const blobId = /^(?:[0-9a-f]{12}|[0-9a-z]{6})$/

// A pasted image's name, chosen by the client (task qy): the host keeps
// it at paths.imageDir()/<name> until a prompt copies it into a blob.
const imageName = /^[0-9a-z]{6}\.(?:png|jpg|gif|webp)$/

// [image/<name>] alone, as clients link it.
const imageMarker = /\[image\/([0-9a-z]{6}\.(?:png|jpg|gif|webp))\]/g

// [image/<name>], [image <blob>] or [paste <blob>, N lines].
const markerPattern = /\[(?:image\/([0-9a-z]{6}\.(?:png|jpg|gif|webp))|image ([0-9a-f]{12})|paste ([0-9a-f]{12}), \d+ lines?)\]/g

// `file`: the image name of an [image/<name>] marker, whose blob is
// the name without its extension.
export type Marker = { text: string; kind: 'image' | 'paste'; blob: string; at: number; file?: string }

function markers(text: string): Marker[] {
	return [...text.matchAll(markerPattern)].map((m) => {
		if (m[1]) return { text: m[0], kind: 'image' as const, blob: m[1].slice(0, 6), at: m.index, file: m[1] }
		return { text: m[0], kind: m[2] ? ('image' as const) : ('paste' as const), blob: (m[2] ?? m[3])!, at: m.index }
	})
}

// A fresh name for a pasted image of `mediaType`: 6 random base36
// characters and its extension, like frdbn1.png.
function newName(mediaType: string): string {
	let chars = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => (b % 36).toString(36)).join('')
	return `${chars}.${types[mediaType]}`
}

// The media type of image name `name`, if it is one.
function nameType(name: string): string | undefined {
	if (!imageName.test(name)) return undefined
	let ext = name.slice(7)
	return Object.keys(types).find((t) => types[t] === ext)
}

// The marker a prompt uses for a stored blob; `lines` for a paste.
function marker(blob: string, mediaType: string, lines = 0): string {
	return mediaType === 'text/plain' ? `[paste ${blob}, ${lines} line${lines === 1 ? '' : 's'}]` : `[image ${blob}]`
}

// "[image 12 kB png]": an image block as one transcript line.
function label(b: Pick<ImageBlock, 'mediaType' | 'bytes'>): string {
	let ext = types[b.mediaType] ?? b.mediaType
	if (b.bytes === undefined) return `[image ${ext}]`
	let size = b.bytes < 1000 ? `${b.bytes} B` : b.bytes < 1e6 ? `${Math.round(b.bytes / 1000)} kB` : `${(b.bytes / 1e6).toFixed(1)} MB`
	return `[image ${size} ${ext}]`
}

export const attachments = {
	types,
	blobId,
	imageName,
	imageMarker,
	newName,
	nameType,
	// Largest attachment, decoded.
	maxBytes: () => 5 * 1024 * 1024,
	markers,
	marker,
	label,
}
