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

// Text files by extension: browsers type many of them oddly or not at
// all (macOS Chrome calls .ts video/mp2t, most give .md and .toml ''),
// and a terminal drop gives only the path.
const textExts = new Set(
	'txt md markdown json jsonc json5 ason asonl ndjson csv tsv log xml svg html htm css scss less js mjs cjs jsx ts mts cts tsx py rb go rs c h cc cpp hpp java kt swift sh bash zsh fish yaml yml toml ini cfg conf env sql graphql lua pl php r diff patch tex rst org'.split(' '),
)
const textTypes = /^(?:text\/|application\/(?:json|xml|javascript|x-sh|x-yaml|yaml|toml|sql|x-httpd-php)\b)/

// How a file (its name, and media type if known) is attached: the
// image's media type, 'text/plain', or undefined when it is neither (a
// PDF, a zip) and is not attached. The web's drop and picker and the
// terminal's dropped paths use this one rule.
function fileKind(name: string, type = ''): string | undefined {
	let ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase()
	if (types[type] && type.startsWith('image/')) return type
	let image = Object.keys(types).find((t) => t.startsWith('image/') && (types[t] === ext || (ext === 'jpeg' && t === 'image/jpeg')))
	if (!type && image) return image
	if ((ext && textExts.has(ext)) || textTypes.test(type)) return 'text/plain'
	// No extension and no type: README, Makefile, LICENSE.
	return !ext && !type ? 'text/plain' : undefined
}

// Blob ids: 12 random lowercase hex digits made by the host, or the
// 6 base36 characters of a pasted image's name (task qy).
const blobId = /^(?:[0-9a-f]{12}|[0-9a-z]{6})$/

// A pasted image's or long text's name, chosen by the client (tasks qy,
// 31): the host keeps it at paths.fileDir(name)/<name> until a prompt
// copies it into a blob.
const fileName = /^[0-9a-z]{6}\.(?:png|jpg|gif|webp|txt)$/

// [image/<name>] or [paste/<name>.txt] alone, as clients link them:
// group 1 is the address of its page on the host (/image/<name>).
const fileMarker = /\[(image\/[0-9a-z]{6}\.(?:png|jpg|gif|webp)|paste\/[0-9a-z]{6}\.txt)\]/g

// [image/<name>], [paste/<name>.txt], and the older [image <blob>] and
// [paste <blob>, N lines] that history may still hold.
const markerPattern = /\[(?:(image|paste)\/([0-9a-z]{6}\.(?:png|jpg|gif|webp|txt))|image ([0-9a-f]{12})|paste ([0-9a-f]{12}), \d+ lines?)\]/g

// `file`: the name of an [image/<name>] or [paste/<name>] marker, whose
// blob is the name without its extension.
export type Marker = { text: string; kind: 'image' | 'paste'; blob: string; at: number; file?: string }

function markers(text: string): Marker[] {
	return [...text.matchAll(markerPattern)].map((m) => {
		if (m[1]) return { text: m[0], kind: m[1] as 'image' | 'paste', blob: m[2]!.slice(0, 6), at: m.index, file: m[2] }
		return { text: m[0], kind: m[3] ? ('image' as const) : ('paste' as const), blob: (m[3] ?? m[4])!, at: m.index }
	})
}

// A fresh name for a paste of `mediaType`: 6 random base36 characters
// and its extension, like frdbn1.png or 0005ab.txt.
function newName(mediaType: string): string {
	let chars = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => (b % 36).toString(36)).join('')
	return `${chars}.${types[mediaType]}`
}

// The media type of pasted file name `name`, if it is one.
function nameType(name: string): string | undefined {
	if (!fileName.test(name)) return undefined
	let ext = name.slice(7)
	return Object.keys(types).find((t) => types[t] === ext)
}

// The marker of pasted file `name`: [image/<name>] or [paste/<name>].
function named(name: string): string {
	return `[${name.endsWith('.txt') ? 'paste' : 'image'}/${name}]`
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
	textExts,
	fileKind,
	blobId,
	fileName,
	fileMarker,
	newName,
	nameType,
	// Largest attachment, decoded.
	maxBytes: () => 5 * 1024 * 1024,
	markers,
	marker,
	named,
	label,
}
