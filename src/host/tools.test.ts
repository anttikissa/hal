import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { tools } from './tools.ts'

let dir = ''
const signal = new AbortController().signal
const origMaxLines = tools.maxLines
const origMaxChars = tools.maxChars

beforeEach(() => {
	dir = mkdtempSync(`${tmpdir()}/hal-tools-`)
})

afterEach(() => {
	tools.maxLines = origMaxLines
	tools.maxChars = origMaxChars
	rmSync(dir, { recursive: true, force: true })
})

const read = (input: Record<string, unknown>) => tools.run({ type: 'tool_call', id: 'c1', name: 'read', input }, { cwd: dir, signal })

test('every tool is offered to the model with an object schema', () => {
	let defs = tools.defs()
	expect(defs.map((d) => d.name)).toContain('read')
	for (let d of defs) expect(d.inputSchema.type).toBe('object')
})

test('read returns a file relative to the session cwd, answering the call id', async () => {
	writeFileSync(`${dir}/a.txt`, 'one\ntwo\n')
	expect(await read({ path: 'a.txt' })).toEqual({ type: 'tool_result', id: 'c1', output: 'one\ntwo\n' })
	expect((await read({ path: `${dir}/a.txt` })).output).toBe('one\ntwo\n')
})

test('read pages through a long file and says how to continue', async () => {
	tools.maxLines = () => 3
	writeFileSync(`${dir}/long.txt`, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
	let first = (await read({ path: 'long.txt' })).output
	expect(first.startsWith('line 1\nline 2\nline 3\n')).toBe(true)
	expect(first).not.toContain('line 4')
	expect(first).toMatch(/offset[^\d]*4/)
	let middle = (await read({ path: 'long.txt', offset: 4, limit: 2 })).output
	expect(middle.startsWith('line 4\nline 5\n')).toBe(true)
	expect(middle).not.toContain('line 6')
	let last = (await read({ path: 'long.txt', offset: 9 })).output
	expect(last).toBe('line 9\nline 10')
})

test('no result exceeds the output bound, however long its lines', async () => {
	tools.maxChars = () => 1000
	writeFileSync(`${dir}/wide.txt`, 'x'.repeat(50_000) + '\nshort\n')
	let { output, isError } = await read({ path: 'wide.txt' })
	expect(isError).toBeUndefined()
	expect(output.length).toBeLessThanOrEqual(1200)
	expect(output).toMatch(/truncated|more/)
})

test('read lists a directory, marking subdirectories', async () => {
	mkdirSync(`${dir}/sub`)
	writeFileSync(`${dir}/b.txt`, '')
	writeFileSync(`${dir}/a.txt`, '')
	expect((await read({ path: '.' })).output).toBe('a.txt\nb.txt\nsub/\n')
})

test('failures are error results, never throws', async () => {
	writeFileSync(`${dir}/bin`, Buffer.from([0x7f, 0x45, 0, 1, 2]))
	for (let input of [{ path: 'missing.txt' }, {}, { path: 7 }, { path: 'bin' }, { path: '.', offset: 'x' }, { path: '.', offset: 0 }]) {
		let r = await read(input)
		expect(r.id).toBe('c1')
		expect(r.isError).toBe(true)
		expect(r.output.length).toBeGreaterThan(0)
	}
	let unknown = await tools.run({ type: 'tool_call', id: 'c2', name: 'nope', input: {} }, { cwd: dir, signal })
	expect(unknown).toMatchObject({ id: 'c2', isError: true })
})
