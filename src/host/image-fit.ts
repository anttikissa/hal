// Encodes and shrinks session image blobs for provider requests: lossless
// WebP for large PNGs on WebP-capable providers, edge capping, and
// last-resort compression when unprunable images exceed a byte budget.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { blocks, type Message } from '../common/blocks.ts'
import { imageDimensions } from '../common/image-dimensions.ts'
import { blobs } from './blobs.ts'
import { paths } from './paths.ts'

export type ImageFormat = 'webp' | 'jpeg'
export type ImageOptions = {
	format?: ImageFormat
	fit?: boolean
	maxBytes?: number
}

// Inline worker run in a child process because Bun.Image is async while
// provider requests build synchronously. Kept inline so a running host
// never pairs with a newer script file. Bun.Image encodes GIFs as PNG.
const CONVERT = `let [path, edgeArg, startArg, fmt, mode, maxArg] = process.argv.slice(1)
let edge = +edgeArg, start = +startArg, max = +maxArg
let run = (side, kind, q, ll) => {
	let img = new Bun.Image(path)
	if (side > 0) img = img.resize(side, side, { fit: 'inside' })
	if (kind === 'webp') img = ll ? img.webp({ lossless: true }) : img.webp({ quality: q })
	else if (kind === 'jpeg') img = img.jpeg({ quality: q })
	return img.bytes()
}
let out
if (mode === 'same') out = await run(edge, 'same', 0, false)
else {
	if (mode === 'lossless') out = await run(edge, 'webp', 0, true)
	if (!out || (max > 0 && out.length > max)) {
		let kind = fmt === 'jpeg' ? 'jpeg' : 'webp'
		out = await run(edge, kind, 85, false)
		if (max > 0 && out.length > max) out = await run(edge, kind, 70, false)
		for (let side = Math.round(start * 0.7); max > 0 && out.length > max && side >= 64; side = Math.round(side * 0.7))
			out = await run(side, kind, 75, false)
		if (max > 0 && out.length > max) out = await run(Math.min(start, 128), kind, 55, false)
	}
}
await Bun.write(Bun.stdout, out)`

function mediaTypeOf(bytes: Uint8Array, fallback: string): string {
	let head = (s: string, at = 0) => [...s].every((c, i) => bytes[at + i] === c.charCodeAt(0))
	if (head('RIFF') && head('WEBP', 8)) return 'image/webp'
	if (head('\xff\xd8\xff')) return 'image/jpeg'
	if (head('\x89PNG\r\n\x1a\n')) return 'image/png'
	if (head('GIF8')) return 'image/gif'
	return fallback
}

function cachePath(
	sessionId: string,
	file: string,
	maxEdge: number,
	mode: 'same' | 'lossless' | 'fit',
	opts: ImageOptions,
): string {
	let dir = `${paths.sessionDir(sessionId)}/shrunk`
	if (mode === 'same') return `${dir}/${maxEdge}-${file}`
	let edgeKey = Number.isFinite(maxEdge) ? String(maxEdge) : 'orig'
	let tag = mode === 'lossless' && !opts.maxBytes ? 'll-webp' : `${mode}-${opts.format ?? 'webp'}-${opts.maxBytes ?? 0}`
	return `${dir}/${edgeKey}-${tag}-${file}`
}

// Encodes `blob` for a provider request, caching derived copies in
// sessions/<id>/shrunk/ so every round sends identical bytes.
function encode(
	sessionId: string,
	blob: string,
	maxEdge = Infinity,
	opts: ImageOptions = {},
): { mediaType: string; data: string } | undefined {
	let found = blobs.find(sessionId, blob)
	if (!found) return undefined
	let bytes = readFileSync(found.path)
	let size = imageDimensions.read(bytes, found.mediaType)
	let longEdge = size ? Math.max(size.width, size.height) : 0
	let overEdge = longEdge > maxEdge
	let overBytes = opts.maxBytes !== undefined && bytes.length > opts.maxBytes
	let wantLossless =
		opts.format === 'webp' && found.mediaType === 'image/png' && bytes.length > imageFit.losslessMinBytes
	let wantFit = !!opts.fit && (overBytes || bytes.length > imageFit.losslessMinBytes)
	if (!overEdge && !wantLossless && !overBytes && !wantFit)
		return { mediaType: found.mediaType, data: bytes.toString('base64') }
	let mode: 'same' | 'lossless' | 'fit' =
		wantLossless && (!wantFit || opts.maxBytes !== undefined) ? 'lossless' : wantFit || overBytes ? 'fit' : 'same'
	let file = found.path.split('/').pop()!
	let path = imageFit.cachePath(sessionId, file, maxEdge, mode, opts)
	if (!existsSync(path)) {
		let edgeArg = overEdge ? maxEdge : 0
		let startArg = Math.min(Number.isFinite(maxEdge) ? maxEdge : 2576, longEdge || 2576)
		let maxArg = overBytes || wantFit ? (opts.maxBytes ?? 0) : 0
		let r = Bun.spawnSync(
			[
				process.execPath,
				'-e',
				CONVERT,
				found.path,
				String(edgeArg),
				String(startArg),
				opts.format ?? 'webp',
				mode,
				String(maxArg),
			],
			{ stderr: 'ignore' },
		)
		if (r.exitCode !== 0 || !r.stdout.length) {
			if (!overEdge && !overBytes) return { mediaType: found.mediaType, data: bytes.toString('base64') }
			return undefined
		}
		// Never replace a file with a larger encoding unless an edge/size cap required it.
		let chosen = !overEdge && !overBytes && r.stdout.length >= bytes.length ? bytes : r.stdout
		mkdirSync(`${paths.sessionDir(sessionId)}/shrunk`, { recursive: true, mode: 0o700 })
		writeFileSync(`${path}.tmp`, chosen)
		renameSync(`${path}.tmp`, path)
	}
	let out = readFileSync(path)
	let fallback = found.mediaType === 'image/gif' ? 'image/png' : found.mediaType
	return { mediaType: imageFit.mediaTypeOf(out, fallback), data: out.toString('base64') }
}

// Raw byte size that `encode` will send for `blob` on `model`: uses the
// cached shrunk/lossless file when present, else the original blob size.
function wireBytes(sessionId: string, blob: string, model?: string): number {
	let found = blobs.find(sessionId, blob)
	if (!found) return 0
	let file = found.path.split('/').pop()!
	let provider = model ? blocks.parseModelId(model)?.provider : undefined
	let maxEdge = provider === 'anthropic' ? 2576 : Infinity
	let webp = provider === 'anthropic' || provider === 'openai' || provider === 'gemini'
	if (webp && found.mediaType === 'image/png') {
		let maxBytes = provider === 'anthropic' ? imageFit.anthropicMaxBytes : undefined
		let cached = imageFit.cachePath(sessionId, file, maxEdge, 'lossless', { format: 'webp', maxBytes })
		let st = statSync(cached, { throwIfNoEntry: false })
		if (st?.isFile()) return st.size
	}
	if (Number.isFinite(maxEdge)) {
		let cached = imageFit.cachePath(sessionId, file, maxEdge, 'same', {})
		let st = statSync(cached, { throwIfNoEntry: false })
		if (st?.isFile()) return st.size
	}
	return statSync(found.path, { throwIfNoEntry: false })?.size ?? 0
}

function countImages(messages: Message[]): number {
	let n = 0
	for (let m of messages)
		for (let b of m.blocks) n += b.type === 'image' ? 1 : b.type === 'tool_result' ? blocks.resultImages(b).length : 0
	return n
}

// Raw per-image byte cap so base64-encoded images plus `textBytes` stay
// under `byteLimit` with headroom.
function perImageCap(messages: Message[], byteLimit: number, textBytes: number): number {
	let count = Math.max(1, imageFit.countImages(messages))
	let availableRaw = Math.max(0, byteLimit - textBytes) * 0.7
	return Math.max(imageFit.minFitBytes, Math.floor(availableRaw / count))
}

export const imageFit = {
	// Only convert PNGs above this size to lossless WebP; small PNGs stay as-is.
	losslessMinBytes: 200_000,
	// Anthropic rejects single images over 5 MB base64 (~3.75 MB raw).
	anthropicMaxBytes: 3_750_000,
	// Smallest per-image target when fitting an overflowing request.
	minFitBytes: 64_000,
	mediaTypeOf,
	cachePath,
	encode,
	wireBytes,
	countImages,
	perImageCap,
}
