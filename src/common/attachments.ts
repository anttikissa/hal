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

// Blob ids are made by the host: 12 random lowercase hex digits.
const blobId = /^[0-9a-f]{12}$/

// [image <blob>] or [paste <blob>, N lines].
const markerPattern = /\[(?:image ([0-9a-f]{12})|paste ([0-9a-f]{12}), \d+ lines?)\]/g

export type Marker = { text: string; kind: 'image' | 'paste'; blob: string; at: number }

function markers(text: string): Marker[] {
	return [...text.matchAll(markerPattern)].map((m) => ({ text: m[0], kind: m[1] ? 'image' : 'paste', blob: (m[1] ?? m[2])!, at: m.index }))
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
	// Largest attachment, decoded.
	maxBytes: () => 5 * 1024 * 1024,
	markers,
	marker,
	label,
}
