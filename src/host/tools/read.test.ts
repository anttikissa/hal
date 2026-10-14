import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { attachments } from '../../common/attachments.ts'
import { blocks } from '../../common/blocks.ts'
import { replay } from '../../common/replay.ts'
import { transcript } from '../../common/transcript.ts'
import { settings } from '../../common/settings.ts'
import { anthropic } from '../anthropic.ts'
import { history } from '../history.ts'
import { openai } from '../openai.ts'
import { openaiCompat } from '../openai-compat.ts'
import { pruning } from '../pruning.ts'
import { blobs } from '../blobs.ts'
import { nativeTool } from '../native-tool.ts'
import { paths } from '../paths.ts'
import { tools } from '../tools.ts'

let home: string
const originalHome = paths.home
const originalMax = attachments.maxBytes
const originalSecurity = settings.security
const ctx = () => ({ cwd: home, sessionId: 's', signal: new AbortController().signal })
const read = (path: string, extra = {}) => tools.run({ type: 'tool_call', id: 'r', name: 'read', input: { path, ...extra } }, ctx())

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-read-image-`)
	paths.home = () => home
	settings.security = () => 'best-effort'
})
afterEach(() => {
	paths.home = originalHome
	attachments.maxBytes = originalMax
	settings.security = originalSecurity
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

test('READ refuses sensitive paths and symlink targets without exposing contents or dropping safe batch siblings', async () => {
	let secret = 'FAKE-SECRET-CONTENT'
	for (let dir of ['.ssh', '.aws', '.gnupg', 'secrets']) mkdirSync(`${home}/${dir}`)
	let sensitive = ['.ssh/id_rsa', '.aws/credentials', '.gnupg/private', 'secrets/token.txt', '.env', '.env.production', 'credentials.json', 'auth.ason', 'id_ed25519', 'private.pem', 'wallet.dat', 'wallet.dat-journal', 'personal.keys']
	for (let path of sensitive) writeFileSync(`${home}/${path}`, secret)
	writeFileSync(`${home}/public.txt`, 'ordinary public content\n')
	writeFileSync(`${home}/image.key`, Buffer.from('89504e470d0a1a0a00000000', 'hex'))
	symlinkSync(`${home}/.ssh/id_rsa`, `${home}/alias.txt`)
	symlinkSync(`${home}/.ssh`, `${home}/alias-dir`)
	symlinkSync(`${home}/public.txt`, `${home}/.env.link`)
	for (let path of [...sensitive, '.ssh', '.ssh/*', 'secrets', 'alias.txt', 'alias-dir', '.env.link', 'image.key', `${home}/.ssh/id_rsa`]) {
		let result = await read(path, { offset: 1, limit: 1 })
		expect(result.isError).toBe(true)
		expect(result.output).toContain(`${path} is a sensitive path`)
		expect(result.output).not.toContain(secret)
		expect(result.image).toBeUndefined()
	}
	let batch = await tools.run({ type: 'tool_call', id: 'batch', ...nativeTool.resolve('READ "public.txt:1-1" "alias.txt" ".ssh/*"') }, ctx())
	expect(batch.isError).toBe(true)
	expect(batch.output).toContain('1: ordinary public content')
	expect(batch.output).toContain('alias.txt is a sensitive path')
	expect(batch.output).toContain('.ssh/* is a sensitive path')
	expect(batch.output).not.toContain(secret)
})

test('security none explicitly permits READ of synthetic sensitive files', async () => {
	writeFileSync(`${home}/.env`, 'FAKE-SECRET-CONTENT\n')
	settings.security = () => 'none'
	let result = await read('.env')
	expect(result.isError).toBeUndefined()
	expect(result.output).toContain('1: FAKE-SECRET-CONTENT')
})

test('batched ranges match individual leased reads; mixed failures preserve successes and are tool errors', async () => {
	writeFileSync(`${home}/a.txt`, 'first\nsecond\nthird\n')
	writeFileSync(`${home}/b.txt`, 'other\ntail\n')
	let next = 0
	let call = (cmd: string) => tools.run({ type: 'tool_call', id: `batch-${++next}`, ...nativeTool.resolve(cmd) }, ctx())
	let batch = await call('READ "a.txt:2-2" "b.txt:1-1"')
	expect(batch.isError).toBeUndefined()
	let a = (await read('a.txt', { offset: 2, limit: 1 })).output
	let b = (await read('b.txt', { offset: 1, limit: 1 })).output
	expect(batch.output).toBe(`${a}\n\n${b}`)
	writeFileSync(`${home}/binary.bin`, Buffer.from([0, 1]))
	let failed = await call('READ "a.txt:2-2" "missing.txt" "binary.bin"')
	expect(failed.isError).toBe(true)
	expect(failed.output.split('\n')[0]).toContain('== READ missing.txt: ENOENT:')
	expect(failed.output.indexOf('binary.bin looks like a binary file')).toBeLessThan(failed.output.indexOf('== READ a.txt@'))
	expect(failed.output).toContain('== READ a.txt@')
	expect(failed.output).toContain('2: second')
	expect(failed.output).toContain('missing.txt')
	expect(failed.output).toContain('ENOENT')
	expect(failed.output).toContain('binary.bin looks like a binary file')
})

test('mixed batches retain every durable image, errors and leases across history and providers', async () => {
	let png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
	let gif = Buffer.from('GIF89a\0\0')
	writeFileSync(`${home}/one.png`, png)
	writeFileSync(`${home}/two.gif`, gif)
	writeFileSync(`${home}/a.txt`, 'first\nsecond\n')
	writeFileSync(`${home}/invalid.txt`, Buffer.from([0xff]))
	let resolved = nativeTool.resolve('READ "one.png" "missing" "a.txt:2-2" "invalid.txt" "two.gif"')
	let result = await tools.run({ type: 'tool_call', id: 'batch', ...resolved }, ctx())
	expect(result.isError).toBe(true)
	expect(result.output).toContain('ENOENT')
	expect(result.output).toContain('missing')
	expect(result.output).toContain('invalid.txt')
	expect(result.output).toContain('== READ a.txt@')
	expect(result.output).toContain('2: second')
	expect(result.output).not.toContain('READ it alone')
	expect(blocks.resultImages(result).map((b) => b.mediaType)).toEqual(['image/png', 'image/gif'])
	for (let name of ['one.png', 'two.gif']) rmSync(`${home}/${name}`)
	history.append('s', { type: 'user', blocks: [{ type: 'text', text: 'read these' }] })
	history.append('s', { type: 'assistant', block: { type: 'tool_call', id: 'batch', ...resolved } })
	let record = history.append('s', { type: 'user', blocks: [result] })
	let records = await history.read('s')
	let messages = replay.toMessages(records)
	let req = { model: 'test', messages, image: (blob: string) => blobs.base64('s', blob) }
	let expected = [png, gif].map((bytes) => bytes.toString('base64'))
	let sent: any = anthropic.toMessages(req).at(-1).content[0]
	expect(sent.is_error).toBe(true)
	expect(sent.content.filter((b: any) => b.type === 'image').map((b: any) => b.source.data)).toEqual(expected)
	let responses: any = openai.input(req).at(-1)
	expect(responses.content.map((b: any) => b.image_url)).toEqual(expected.map((data, i) => `data:${i ? 'image/gif' : 'image/png'};base64,${data}`))
	let chat: any = openaiCompat.toMessages(req).at(-1)
	expect(chat.content.filter((b: any) => b.type === 'image_url').map((b: any) => b.image_url.url)).toEqual(responses.content.map((b: any) => b.image_url))
	let recovered = await tools.run({ type: 'tool_call', id: 'recover', name: 'read_blob', input: { id: `t${record.n}` } }, ctx())
	expect(blocks.resultImages(recovered).map((b) => blobs.base64('s', b.blob))).toEqual(expected)
	let shown = transcript.recordItems(record, 0)
	expect(shown.filter((b) => b.type === 'image').map((b) => b.blob)).toEqual(blocks.resultImages(result).map((b) => b.blob))
	expect(new Set(shown.map((b) => b.key)).size).toBe(3)
	let omitted = pruning.omit('s', record)
	expect(omitted.type).toBe('user')
	if (omitted.type === 'user' && omitted.blocks[0]?.type === 'tool_result') {
		expect(blocks.resultImages(omitted.blocks[0])).toEqual([])
		for (let [i] of blocks.resultImages(result).entries()) expect(omitted.blocks[0].output).toContain(`s/${record.n}.${i + 1}`)
	}
	let withoutImages = messages.map((m) => ({ ...m, blocks: m.blocks.map((b) => b.type === 'tool_result' ? { ...b, images: undefined } : b) })) as typeof messages
	expect(pruning.estimate('s', messages) - pruning.estimate('s', withoutImages)).toBeGreaterThanOrEqual(2 * pruning.maxImageTokens)
	let missing = blocks.resultImages(result)[0]!
	rmSync(blobs.find('s', missing.blob)!.path)
	let partial = await tools.run({ type: 'tool_call', id: 'partial', name: 'read_blob', input: { id: `t${record.n}` } }, ctx())
	expect(partial.isError).toBe(true)
	expect(partial.output).toContain(`image blob s/${missing.blob} not found`)
	expect(blocks.resultImages(partial).map((b) => blobs.base64('s', b.blob))).toEqual([expected[1]])
})

test('successful image batches and legacy single-image records share replay and display behavior', async () => {
	let png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
	writeFileSync(`${home}/one.png`, png)
	let batch = await tools.run({ type: 'tool_call', id: 'r', ...nativeTool.resolve('READ "one.png" "one.png"') }, ctx())
	expect(batch.isError).toBeUndefined()
	expect(blocks.resultImages(batch)).toHaveLength(2)
	let single = await read('one.png')
	expect(single.images).toBeUndefined()
	expect(single.image).toBeDefined()
	let record = { type: 'user' as const, n: 3, ts: '', blocks: [single] }
	expect(transcript.recordItems(record, 0).filter((b) => b.type === 'image')).toHaveLength(1)
	let recoveredRecord = history.append('s', record)
	let recovered = await tools.run({ type: 'tool_call', id: 'old', name: 'read_blob', input: { id: `t${recoveredRecord.n}` } }, ctx())
	expect(blocks.resultImages(recovered)).toHaveLength(1)
})

test('READ_BLOB recovers images from every sibling result and direct image in a user record', async () => {
	let png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
	let saved = Array.from({ length: 4 }, () => blobs.store('s', 'image/png', png.toString('base64')))
	let images = saved.map((b) => ({ type: 'image' as const, blob: b.blob, mediaType: b.mediaType, bytes: b.bytes }))
	let record = history.append('s', { type: 'user', blocks: [
		{ type: 'tool_result', id: 'legacy', output: 'legacy output', image: images[0] },
		{ type: 'tool_result', id: 'multi', output: 'multi output', images: images.slice(1, 3) },
		images[3]!,
	] })
	let recover = () => tools.run({ type: 'tool_call', id: 'recover', name: 'read_blob', input: { id: `t${record.n}` } }, ctx())
	let whole = await recover()
	expect(whole.isError).toBeUndefined()
	expect(blocks.resultImages(whole)).toHaveLength(4)
	expect(whole.output).toContain('legacy output')
	expect(whole.output).toContain('multi output')
	for (let image of images) expect(whole.output).toContain(image.blob)
	rmSync(blobs.find('s', images[1]!.blob)!.path)
	let partial = await recover()
	expect(partial.isError).toBe(true)
	expect(blocks.resultImages(partial)).toHaveLength(3)
	expect(partial.output).toContain(`image blob s/${images[1]!.blob} not found`)
	for (let image of images.filter((_, i) => i !== 1)) rmSync(blobs.find('s', image.blob)!.path)
	let gone = await recover()
	expect(gone.isError).toBe(true)
	expect(blocks.resultImages(gone)).toEqual([])
	for (let image of images) expect(gone.output).toContain(`image blob s/${image.blob} not found`)
})
