import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { attachments } from '../../common/attachments.ts'
import { blobs } from '../blobs.ts'
import { paths } from '../paths.ts'
import { tools } from '../tools.ts'

let home: string
const originalHome = paths.home
const originalMax = attachments.maxBytes
const ctx = () => ({ cwd: home, sessionId: 's', signal: new AbortController().signal })
const read = (path: string, extra = {}) => tools.run({ type: 'tool_call', id: 'r', name: 'read', input: { path, ...extra } }, ctx())

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-read-image-`)
	paths.home = () => home
})
afterEach(() => {
	paths.home = originalHome
	attachments.maxBytes = originalMax
	rmSync(home, { recursive: true, force: true })
})

test('local images are detected by bytes and stored for replay after source deletion', async () => {
	let images = [
		['image/png', 'screenshot.png', Buffer.from('89504e470d0a1a0a00000000', 'hex')],
		['image/jpeg', 'photo.jpeg', Buffer.from('ffd8ff000000', 'hex')],
		['image/gif', 'no-extension', Buffer.from('GIF89a\0\0')],
		['image/webp', 'misleading.txt', Buffer.from('RIFF\0\0\0\0WEBP')],
	] as const
	for (let [mediaType, name, bytes] of images) {
		let path = `${home}/${name}`
		writeFileSync(path, bytes)
		let result = await read(path, { offset: 2, limit: 1 })
		expect(result.isError).toBeUndefined()
		expect(result.image).toMatchObject({ type: 'image', mediaType, bytes: bytes.length })
		expect(result.output).toContain(path)
		rmSync(path)
		expect(blobs.base64('s', result.image!.blob)).toBe(bytes.toString('base64'))
	}
})

test('image size cap accepts the boundary and rejects larger images; text and other binaries keep their behavior', async () => {
	attachments.maxBytes = 32
	let png = Buffer.alloc(32)
	png.set(Buffer.from('89504e470d0a1a0a', 'hex'))
	writeFileSync(`${home}/limit.png`, png)
	expect((await read('limit.png')).image?.bytes).toBe(32)
	writeFileSync(`${home}/large.png`, Buffer.concat([png, Buffer.from([0])]))
	let large = await read('large.png')
	expect(large.isError).toBe(true)
	expect(large.image).toBeUndefined()
	writeFileSync(`${home}/text.png`, 'one\ntwo\nthree\n')
	expect((await read('text.png', { offset: 2, limit: 1 })).output).toEndWith(' ==\n2: two')
	writeFileSync(`${home}/binary.png`, Buffer.from([0, 1, 2]))
	expect((await read('binary.png')).isError).toBe(true)
	expect((await read('limit.png', { offset: 0 })).isError).toBe(true)
})

test('a READ without a range shows the first 200 lines and how to get more; offset 1 alone reads all', async () => {
	writeFileSync(`${home}/long.txt`, Array.from({ length: 300 }, (_, i) => `line ${i + 1}\n`).join(''))
	let first = (await read('long.txt')).output
	expect(first).toContain('line 200')
	expect(first).not.toContain('line 201')
	expect(first).toContain('READ "long.txt:201-300" for more, "long.txt:1-" for the whole file')
	let whole = (await read('long.txt', { offset: 1 })).output
	expect(whole).toContain('line 300')
	expect(whole).not.toContain('for more')
})
