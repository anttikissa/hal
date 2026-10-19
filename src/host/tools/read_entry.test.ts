import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { blocks, type ToolResultBlock } from '../../common/blocks.ts'
import { transcript } from '../../common/transcript.ts'
import { blobs } from '../blobs.ts'
import { history } from '../history.ts'
import { paths } from '../paths.ts'
import { pruning } from '../pruning.ts'
import { nativeTool } from '../native-tool.ts'
import { tools } from '../tools.ts'

let home: string
let originalHome = paths.home
const signal = new AbortController().signal
const read = (id: string, page = {}) =>
	tools.run(
		{ type: 'tool_call', id: 'recover', name: 'read_entry', input: { id, ...page } },
		{ sessionId: 'reader', cwd: home, signal },
	)

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-read-blob-`)
	paths.home = () => home
	mkdirSync(paths.sessionDir('source'), { recursive: true })
})

afterEach(() => {
	paths.home = originalHome
	rmSync(home, { recursive: true, force: true })
})

test('history addresses recover complete output and match each displayed image slot', async () => {
	let png = Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64')
	let gif = Buffer.from('GIF89a\0\0').toString('base64')
	let images = [blobs.store('source', 'image/png', png), blobs.store('source', 'image/gif', gif)].map((b) => ({
		type: 'image' as const,
		blob: b.blob,
		mediaType: b.mediaType,
	}))
	let whole = Array.from({ length: 300 }, (_, i) => `payload ${i}\n`).join('')
	let saved: ToolResultBlock = { type: 'tool_result', id: 'large', output: '' }
	saved.output = tools.cap(whole, 'source', 900, Infinity, (blob) => {
		saved.outputBlob = blob
	})
	let record = history.append('source', {
		type: 'user',
		blocks: [{ type: 'tool_result', id: 'images', output: 'two images', images }, saved],
	})
	let items = transcript.recordItems(
		history.readSync('source').find((r) => r.n === record.n)!,
		0,
	)
	expect(items.map((i) => i.key)).toEqual([`${record.n}`, `${record.n}.1`, `${record.n}.2`, `${record.n}.3`])
	expect(saved.output).toContain(`READ_ENTRY "source/${record.n}.3"`)
	expect(saved.output.length).toBeLessThanOrEqual(900)
	let omitted = pruning.omit('source', record)
	if (omitted.type !== 'user' || omitted.blocks[0]?.type !== 'tool_result') throw new Error('missing pruned result')
	let marker = omitted.blocks[0].output.split('\n')[1]!
	let rejected = await tools.run(
		{ type: 'tool_call', id: 'copied', name: 'bash', input: { command: `printf '%s' '${marker}'` } },
		{ sessionId: 'source', cwd: home, signal },
	)
	expect(rejected.isError).toBe(true)
	expect(rejected.output).toContain('actual value')
	let recovered = await read(`source/${record.n}.3`, { offset: 151, limit: 1 })
	expect(recovered.output).toStartWith('payload 150\n')
	expect(recovered.isError).toBeUndefined()
	for (let [slot, expected] of [
		[1, png],
		[2, gif],
	] as const) {
		let result = await read(`source/${record.n}.${slot}`)
		expect(blobs.base64('reader', blocks.resultImages(result)[0]!.blob)).toBe(expected)
	}
	expect((await read(`source/${record.n}.0`)).output).toBe('two images')
	expect((await read(`source/${record.n}.3`, { offset: 151, limit: 1 })).output).toStartWith('payload 150\n')
	expect(blocks.resultImages(await read(`source/${record.n}`))).toHaveLength(2)
	for (let ref of [
		`source/${record.n}.9`,
		'source/0',
		'source/9007199254740992',
		'source/1.9007199254740992',
		'source/../1',
	])
		expect((await read(ref)).isError).toBe(true)
})

test('legacy capped history records recover their full blob without metadata', async () => {
	let whole = 'unbroken'.repeat(2000)
	let preview = tools.cap(whole, 'source', 900)
	let record = history.append('source', {
		type: 'user',
		blocks: [{ type: 'tool_result', id: 'legacy', output: preview }],
	})
	let recovered = await read(`source/${record.n}`, { charOffset: 5001 })
	expect(recovered.output).toStartWith(whole.slice(5000, 5100))
	let blob = preview.match(/whole output in blob ([0-9a-f]{12})/)![1]!
	expect((await read(`source/${blob}`, { charOffset: 5001 })).output).toBe(recovered.output)
	writeFileSync(`${blobs.dir('source')}/123456.txt`, 'legacy numeric blob')
	expect((await read('source/123456')).output).toBe('legacy numeric blob')
	expect(() =>
		history.check({
			type: 'user',
			n: 1,
			ts: new Date().toISOString(),
			blocks: [{ type: 'tool_result', id: 'bad', output: '', outputBlob: '../private' }],
		}),
	).toThrow('invalid tool output blob')
})

test('rebased output replaces the original blob and drops its former image slot', async () => {
	let whole = blobs.storeOutput('source', 'original full output')
	let image = blobs.store('source', 'image/gif', Buffer.from('GIF89a\0\0').toString('base64'))
	let record = history.append('source', {
		type: 'user',
		blocks: [
			{
				type: 'tool_result',
				id: 'old',
				output: 'original preview',
				outputBlob: whole.blob,
				images: [{ type: 'image', blob: image.blob, mediaType: image.mediaType }],
			},
		],
	})
	rmSync(whole.path)
	let partial = await read(`source/${record.n}`)
	expect(partial.isError).toBe(true)
	expect(partial.output).toContain(`no blob ${whole.blob} in ${blobs.dir('source')}`)
	expect(blocks.resultImages(partial)).toHaveLength(1)
	history.append('source', {
		type: 'rebase',
		base: record.n!,
		drop: [],
		edit: [{ n: record.n!, text: 'replacement output' }],
	})
	let recovered = await read(`source/${record.n}`)
	expect(recovered.output).toBe('replacement output')
	expect(blocks.resultImages(recovered)).toEqual([])
	expect((await read(`source/${record.n}.1`)).isError).toBe(true)
	history.append('source', { type: 'rebase', base: record.n!, drop: [record.n!], edit: [] })
	expect((await read(`source/${record.n}`)).output).toContain('was dropped by rebase')
})

test('READ_ENTRY call text with several ids reads each', async () => {
	let a = history.append('source', { type: 'user', blocks: [{ type: 'tool_result', id: 'a', output: 'first output' }] })
	let b = history.append('source', {
		type: 'user',
		blocks: [{ type: 'tool_result', id: 'b', output: 'second output' }],
	})
	let { name, input } = nativeTool.resolve(`READ_ENTRY "source/${a.n}" "source/${b.n}"`)
	let result = await tools.run(
		{ type: 'tool_call', id: 'both', name, input },
		{ sessionId: 'reader', cwd: home, signal },
	)
	expect(result.isError).toBeUndefined()
	expect(result.output).toBe(
		`== READ_ENTRY source/${a.n} ==\nfirst output\n\n== READ_ENTRY source/${b.n} ==\nsecond output`,
	)
	expect(nativeTool.resolve('READ_ENTRY "t1" { offset: 2 }').input).toEqual({ id: 't1', offset: 2 })
})
