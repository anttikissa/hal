// Wire image fitting: lossless WebP for large PNGs on WebP-capable providers,
// JPEG fallback for OpenAI-compatible servers, and tight byte-budget fitting.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { crc32, deflateSync } from 'zlib'
import { blobs } from './blobs.ts'
import { imageFit } from './image-fit.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'

let home = ''
let priorHome = paths.state.home
let priorMin = imageFit.losslessMinBytes

function makePng(width: number, height: number, noisy = false): Buffer {
	let chunk = (type: string, data: Buffer) => {
		let body = Buffer.concat([Buffer.from(type, 'latin1'), data])
		let n = (v: number) => Buffer.from([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255])
		return Buffer.concat([n(data.length), body, n(crc32(body))])
	}
	let ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
	let raw = Buffer.alloc(height * (1 + width * 3))
	for (let y = 0; y < height; y++) {
		let row = y * (1 + width * 3)
		raw[row] = 0
		for (let x = 0; x < width; x++) {
			let i = row + 1 + x * 3
			raw[i] = noisy ? (x * 73 + y * 139 + ((x * y) % 97)) & 255 : (x + y) & 255
			raw[i + 1] = noisy ? (x * 191 + y * 41) & 255 : (x * 2) & 255
			raw[i + 2] = noisy ? (x * 29 + y * 211) & 255 : (y * 3) & 255
		}
	}
	return Buffer.concat([
		Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 0 })),
		chunk('IEND', Buffer.alloc(0)),
	])
}

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-image-fit-`)
	paths.state.home = home
})

afterEach(() => {
	sessions.closeAll()
	imageFit.losslessMinBytes = priorMin
	if (priorHome === undefined) paths.state.home = undefined
	else paths.state.home = priorHome
	rmSync(home, { recursive: true, force: true })
})

test('large PNG encodes once as lossless WebP on WebP providers, keeps PNG on non-WebP, and fits to JPEG/WebP under cap', () => {
	imageFit.losslessMinBytes = 10_000
	let id = sessions.create({ cwd: home, model: 'anthropic/test' }).id
	let png = makePng(240, 180, true)
	expect(png.length).toBeGreaterThan(100_000)
	let stored = blobs.store(id, 'image/png', png.toString('base64'))

	// WebP-capable provider: lossless VP8L, smaller than original PNG, cached deterministically.
	let first = blobs.image(id, stored.blob, 2576, { format: 'webp', maxBytes: imageFit.anthropicMaxBytes })!
	expect(first.mediaType).toBe('image/webp')
	let firstBytes = Buffer.from(first.data, 'base64')
	expect(firstBytes.toString('ascii', 12, 16)).toBe('VP8L')
	expect(firstBytes.length).toBeLessThan(png.length)
	expect(blobs.image(id, stored.blob, 2576, { format: 'webp', maxBytes: imageFit.anthropicMaxBytes })).toEqual(first)
	expect(imageFit.wireBytes(id, stored.blob, 'anthropic/test')).toBe(firstBytes.length)
	// Original blob on disk is untouched.
	expect(blobs.read(id, stored.blob)!.bytes).toEqual(png)

	// Non-WebP provider (normal turn): keeps original PNG untouched.
	let compat = blobs.image(id, stored.blob, Infinity, { format: 'jpeg' })!
	expect(compat.mediaType).toBe('image/png')
	expect(Buffer.from(compat.data, 'base64').equals(png)).toBe(true)

	// Tight fit cap: WebP steps down to lossy WebP, non-WebP falls back to JPEG under the cap.
	let tightWebp = blobs.image(id, stored.blob, 2576, { format: 'webp', fit: true, maxBytes: 15_000 })!
	expect(tightWebp.mediaType).toBe('image/webp')
	expect(Buffer.from(tightWebp.data, 'base64').length).toBeLessThanOrEqual(15_000)

	let tightJpeg = blobs.image(id, stored.blob, Infinity, { format: 'jpeg', fit: true, maxBytes: 15_000 })!
	expect(tightJpeg.mediaType).toBe('image/jpeg')
	expect(Buffer.from(tightJpeg.data, 'base64').length).toBeLessThanOrEqual(15_000)
})
