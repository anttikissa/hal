// Image uploads from the web client. This lives apart from web.ts so config.ts
// can register its settings without dragging the whole server runtime into the
// import graph (config -> web -> runtime -> config would be a cycle).
//
// Screenshots and other images are stored under state/uploads/ and referenced
// in prompts as [path]; the attachment resolver turns those markers into image
// blocks for the model. Blob ids are reused for names because they are unique
// per session timeline; 'uploads' is not a real session id, so makeBlobId just
// falls back to now().

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { blob } from './session/blob.ts'
import { STATE_DIR } from './state.ts'
import { serverKeys } from './server-keys.ts'

const IMAGE_UPLOAD_TYPES: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
}

// Some Android pickers send an empty Content-Type, so fall back to the name.
const EXT_TO_TYPE: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
}

// Upload limits are read at request time so eval and /config can tune them live.
const config = {
	maxUploadBytes: 8 * 1024 * 1024,
}

function uploadDir(): string {
	return `${STATE_DIR}/uploads`
}

function saveUpload(name: string, type: string, data: ArrayBuffer): { status: number; body: unknown } {
	if (!IMAGE_UPLOAD_TYPES[type]) {
		const dot = name.lastIndexOf('.')
		type = dot >= 0 ? EXT_TO_TYPE[name.slice(dot + 1).toLowerCase()] ?? '' : ''
	}
	const ext = IMAGE_UPLOAD_TYPES[type]
	if (!ext) return { status: 415, body: { error: 'Unsupported media type; expected png, jpeg, gif or webp' } }
	if (data.byteLength === 0) return { status: 400, body: { error: 'Empty upload' } }
	const max = config.maxUploadBytes
	if (data.byteLength > max) return { status: 413, body: { error: `Image exceeds the ${max / 1024 / 1024}MB upload limit` } }

	// Splitting on both slash types beats basename() here: Windows-style input
	// would keep directory segments, and '..' must never survive as a name.
	let base = name.split(/[\\/]/).pop() ?? ''
	if (!base || base === '.' || base === '..') base = 'image'
	mkdirSync(uploadDir(), { recursive: true })
	const path = join(uploadDir(), `${blob.makeBlobId('uploads')}-${base}`)
	writeFileSync(path, Buffer.from(data), { mode: 0o600 })
	return { status: 200, body: { path } }
}

async function handleUploadRequest(request: Request, ip: string): Promise<Response> {
	// Same constant-time token check as the WebSocket handshake.
	const url = new URL(request.url)
	if (!serverKeys.authenticate(url.searchParams.get('auth') ?? '', ip)) {
		return new Response('Unauthorized', { status: 401 })
	}
	let form: FormData
	try {
		form = await request.formData()
	} catch {
		return new Response('Expected multipart form data with a "file" field', { status: 400 })
	}
	const file = form.get('file')
	if (!(file instanceof File)) return new Response('Expected multipart form data with a "file" field', { status: 400 })
	const result = saveUpload(file.name, file.type, await file.arrayBuffer())
	return new Response(JSON.stringify(result.body), {
		status: result.status,
		headers: { 'content-type': 'application/json' },
	})
}

export const webUpload = { config, uploadDir, saveUpload, handleUploadRequest }
