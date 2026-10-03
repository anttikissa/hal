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

// The file's upload kind. Unknown binary formats use octet-stream and
// keep a safe extension; all their bytes stay opaque.
function fileKind(name: string, type = ''): string | undefined {
	let ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase()
	if (types[type] && type.startsWith('image/')) return type
	let image = Object.keys(types).find((t) => t.startsWith('image/') && (types[t] === ext || (ext === 'jpeg' && t === 'image/jpeg')))
	if (!type && image) return image
	if ((ext && textExts.has(ext)) || textTypes.test(type)) return 'text/plain'
	if (!ext && !type) return 'text/plain'
	return 'application/octet-stream'
}

// Blob ids: 12 random lowercase hex digits made by the host, or the
// 6 base36 characters of a pasted image's name (task qy).
const blobId = /^(?:[0-9a-f]{12}|[0-9a-z]{6})$/

// A pasted image's or text's name, chosen by the client (tasks qy,
// 31): 6 base36 characters and an extension, the image's or the text
// file's own (.md, .csv; .txt for a pasted text or a file without one).
// The host keeps it at paths.fileDir(name)/<name> until a prompt copies
// it into a blob.
const safeExt = '[a-z0-9]{1,8}'
const fileName = new RegExp(`^[0-9a-z]{6}\\.${safeExt}$`)

// Marker addresses are links in both clients.
const fileMarker = new RegExp(`\\[((?:image\\/[0-9a-z]{6}\\.(?:png|jpg|gif|webp)|paste\\/[0-9a-z]{6}\\.(?:${[...textExts].join('|')})|file\\/[0-9a-z]{6}\\.${safeExt}))\\]`, 'g')
const markerPattern = new RegExp(`\\[(?:(image|paste|file)\\/([0-9a-z]{6}\\.${safeExt})|image ([0-9a-f]{12})|paste ([0-9a-f]{12}), \\d+ lines?)\\]`, 'g')

// `file`: the name of an [image/<name>] or [paste/<name>] marker, whose
// blob is the name without its extension.
export type Marker = { text: string; kind: 'image' | 'paste' | 'file'; blob: string; at: number; file?: string }

function markers(text: string): Marker[] {
	return [...text.matchAll(markerPattern)].map((m) => {
		if (m[1]) return { text: m[0], kind: m[1] as Marker['kind'], blob: m[2]!.slice(0, 6), at: m.index, file: m[2] }
		return { text: m[0], kind: m[3] ? ('image' as const) : ('paste' as const), blob: (m[3] ?? m[4])!, at: m.index }
	})
}

// A fresh name for a paste of `mediaType`: 6 random base36 characters
// and its extension, like frdbn1.png or 0005ab.txt. A text file keeps
// its own extension if it is a known text one (`from`: its file name).
function newName(mediaType: string, from = ''): string {
	let chars = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => (b % 36).toString(36)).join('')
	let own = /\.([^./]+)$/.exec(from)?.[1]?.toLowerCase()
	let ext = mediaType === 'application/octet-stream' ? own && /^[a-z0-9]{1,8}$/.test(own) && !textExts.has(own) && !Object.values(types).includes(own) ? own : 'bin' : mediaType === 'text/plain' && own && textExts.has(own) ? own : types[mediaType]
	return `${chars}.${ext}`
}

// The media type of pasted file name `name`, if it is one.
function nameType(name: string): string | undefined {
	if (!fileName.test(name)) return undefined
	let ext = name.slice(7)
	return textExts.has(ext) ? 'text/plain' : Object.keys(types).find((t) => types[t] === ext) ?? 'application/octet-stream'
}

// The marker of pasted file `name`: [image/<name>] or [paste/<name>].
function named(name: string): string {
	return `[${nameType(name) === 'text/plain' ? 'paste' : nameType(name) === 'application/octet-stream' ? 'file' : 'image'}/${name}]`
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
	maxBytes: 5 * 1024 * 1024,
	markers,
	marker,
	named,
	label,
}
