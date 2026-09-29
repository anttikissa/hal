import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { tools } from './tools.ts'

let dir = ''
const signal = new AbortController().signal
const origMaxLines = tools.maxLines
const origMaxChars = tools.maxChars
const origKillAfter = tools.killAfterMs
const origDir = tools.dir

beforeEach(() => {
	dir = mkdtempSync(`${tmpdir()}/hal-tools-`)
})

afterEach(() => {
	tools.maxLines = origMaxLines
	tools.maxChars = origMaxChars
	tools.killAfterMs = origKillAfter
	tools.dir = origDir
	rmSync(dir, { recursive: true, force: true })
})

const read = (input: Record<string, unknown>) => tools.run({ type: 'tool_call', id: 'c1', name: 'read', input }, { cwd: dir, signal, sessionId: 's' })


const echo = (name: string, readOnly: boolean) => `export const tool = {
	name: '${name}', description: 'echo', parameters: { type: 'object', properties: {} }, ${readOnly ? 'readOnly: true,' : ''}
	run: async (input) => 'echo ' + JSON.stringify(input),
}
`

test('a tool file dropped into the tools directory is offered and run, nothing else changed', async () => {
	let toolDir = `${dir}/tools`
	mkdirSync(toolDir)
	writeFileSync(`${toolDir}/echo.ts`, echo('echo', true))
	writeFileSync(`${toolDir}/echo.test.ts`, 'throw new Error("tests are not tools")')
	writeFileSync(`${toolDir}/notes.md`, 'not a tool')
	tools.dir = () => toolDir
	expect(tools.defs()).toEqual([{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }])
	expect(tools.readOnly('echo')).toBe(true)
	let result = await tools.run({ type: 'tool_call', id: 'e1', name: 'echo', input: { a: 1 } }, { cwd: dir, signal, sessionId: 's' })
	expect(result).toEqual({ type: 'tool_result', id: 'e1', output: 'echo {"a":1}' })
})

test('a tool file must be named like its tool', () => {
	let toolDir = `${dir}/tools`
	mkdirSync(toolDir)
	writeFileSync(`${toolDir}/wrong.ts`, echo('other', false))
	tools.dir = () => toolDir
	expect(() => tools.defs()).toThrow('wrong.ts')
})

test('only tools that change nothing count as read-only; unknown ones do not', () => {
	expect(tools.readOnly('read')).toBe(true)
	expect(tools.readOnly('bash')).toBe(false)
	expect(tools.readOnly('nope')).toBe(false)
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
	let unknown = await tools.run({ type: 'tool_call', id: 'c2', name: 'nope', input: {} }, { cwd: dir, signal, sessionId: 's' })
	expect(unknown).toMatchObject({ id: 'c2', isError: true })
})

const bash = (input: Record<string, unknown>, sig = signal) =>
	tools.run({ type: 'tool_call', id: 'b1', name: 'bash', input }, { cwd: dir, signal: sig, sessionId: 's' })

test('bash runs in the session cwd and returns exit status with stdout and stderr interleaved', async () => {
	writeFileSync(`${dir}/a.txt`, 'hello\n')
	let r = await bash({ command: 'cat a.txt; echo oops >&2; echo after; exit 3', description: 'Show a file then fail' })
	expect(r.id).toBe('b1')
	expect(r.output).toMatch(/\b3\b/)
	expect(r.output).toContain('hello\noops\nafter\n')
	expect((await bash({ command: 'pwd', description: 'Show the cwd' })).output).toContain(realpathSync(dir))
})

test('bash without a description is an error and does not run the command', async () => {
	for (let description of [undefined, '', '   ', 7]) {
		let r = await bash({ command: 'touch ran', description })
		expect(r.isError).toBe(true)
		expect(existsSync(`${dir}/ran`)).toBe(false)
	}
	expect((await bash({ description: 'Nothing' })).isError).toBe(true)
})

test('cancel stops a running command, pipelines included, and a cancelled turn runs nothing more', async () => {
	let ac = new AbortController()
	let started = Date.now()
	let pending = bash({ command: 'sleep 30 | cat; touch late', description: 'Wait' }, ac.signal)
	await Bun.sleep(200)
	ac.abort()
	await pending
	expect(Date.now() - started).toBeLessThan(5000)
	await Bun.sleep(100)
	expect(existsSync(`${dir}/late`)).toBe(false)
	let r = await bash({ command: 'touch ran', description: 'Touch' }, ac.signal)
	expect(r.isError).toBe(true)
	expect(existsSync(`${dir}/ran`)).toBe(false)
})

test('a stopped command is asked to end, then killed: a background job that ignores SIGTERM does not survive', async () => {
	tools.killAfterMs = () => 300
	let marker = `31.${process.pid}2`
	let alive = () => Bun.spawnSync(['pgrep', '-f', `sleep ${marker}`]).stdout.toString().trim() !== ''
	let ac = new AbortController()
	let pending = bash({ command: `trap '' TERM; sleep ${marker} >/dev/null & sleep ${marker}`, description: 'Leave a stubborn job' }, ac.signal)
	for (let i = 0; i < 100 && !alive(); i++) await Bun.sleep(20)
	expect(alive()).toBe(true)
	ac.abort()
	await Bun.sleep(100)
	expect(alive()).toBe(true)
	expect((await pending).output).toContain('stopped')
	for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(20)
	expect(alive()).toBe(false)
})

test('a command past its timeout is killed with its background jobs, keeping the output so far', async () => {
	let marker = `33.${process.pid}4`
	let alive = () => Bun.spawnSync(['pgrep', '-f', `sleep ${marker}`]).stdout.toString().trim() !== ''
	let started = Date.now()
	// The background job holds stdout open: without the timeout the call would wait for it.
	let r = await bash({ command: `echo before; sleep ${marker} &`, description: 'Leave a job holding stdout', timeout: 300 })
	expect(Date.now() - started).toBeLessThan(3000)
	expect(r.output).toContain('timed out after 0.3s')
	expect(r.output).toContain('before')
	for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(20)
	expect(alive()).toBe(false)
})

// The persisted blob is the source of truth, not the preview returned
// to the model. Use a private home so images and history are isolated.
import { paths } from './paths.ts'
import { blobs } from './blobs.ts'
import { history } from './history.ts'

const originalHome = paths.home
const blobRun = (id: string, options: { offset?: number; limit?: number } = {}) => tools.run({ type: 'tool_call', id: 'rb', name: 'read_blob', input: { id, ...options } }, { cwd: dir, signal, sessionId: 's' })

test('large bash output is bounded, keeps both ends and the whole result in a session blob', async () => {
	paths.home = () => dir
	try {
		tools.maxChars = () => 1000
		let result = await bash({ command: "printf 'START\\n'; yes middle | head -c 80000; printf '\\nEND\\n'; exit 7", description: 'Produce long output and fail' })
		expect(result.output.length).toBeLessThanOrEqual(1200)
		expect(result.output).toContain('START')
		expect(result.output).toContain('END')
		expect(result.output).toContain('exit 7')
		let id = result.output.match(/whole output in blob ([0-9a-f]{12})/)?.[1]
		expect(id).toBeDefined()
		let first = (await blobRun(id!)).output
		expect(first).toContain('START')
		let total = Number(first.match(/of (\d+); continue/)?.[1])
		let end = (await blobRun(id!, { offset: total - 2 })).output
		expect(end).toContain('END')
		expect(total).toBeGreaterThan(1000)
	} finally { paths.home = originalHome }
})

test('read_blob resolves text and images and rejects unknown or escaping references', async () => {
	paths.home = () => dir
	try {
		let text = blobs.storeOutput('s', 'unaltered text')
		expect((await blobRun(text.blob)).output).toBe('unaltered text')
		expect((await blobRun(`s/${text.blob}`)).output).toBe('unaltered text')
		let image = blobs.store('s', 'image/png', Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64'))
		let r = await blobRun(image.blob)
		expect(r.image?.mediaType).toBe('image/png')
		expect(blobs.base64('s', r.image!.blob)).toBe(blobs.base64('s', image.blob))
		for (let id of ['unknown', '../etc/passwd', 's/../../etc/passwd', 's/missing', 'aaaaaaaaaaaa']) {
			expect((await blobRun(id)).isError).toBe(true)
		}
	} finally { paths.home = originalHome }
})

test('read_blob pages large text and history blocks within the result cap', async () => {
	paths.home = () => dir
	let max = tools.maxChars
	try {
		tools.maxChars = () => 900
		let lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}: ${'x'.repeat(60)}\n`)
		let id = blobs.storeOutput('s', lines.join('')).blob
		let first = (await blobRun(id)).output
		expect(first.length).toBeLessThanOrEqual(tools.maxChars())
		let next = Number(first.match(/continue with offset (\d+)/)?.[1])
		expect(next).toBeGreaterThan(1)
		expect((await blobRun(id, { offset: next })).output).toContain(`line ${next}:`)
		let selected = (await blobRun(id, { offset: 18, limit: 2 })).output
		expect(selected).toContain('line 18:')
		expect(selected).not.toContain('line 20:')
		expect((await blobRun(id, { offset: 51 })).isError).toBe(true)
		let record = history.append('s', { type: 'user', blocks: lines.map((text) => ({ type: 'text' as const, text })) })
		let block = (await blobRun(`#${record.n}`)).output
		expect(block.length).toBeLessThanOrEqual(tools.maxChars())
		expect(block).toContain('continue with offset')
		expect((await blobRun(id, { offset: 0 })).isError).toBe(true)
	} finally { paths.home = originalHome; tools.maxChars = max }
})

test('read_blob fetches a numbered tool call and its result from history', async () => {
	paths.home = () => dir
	try {
		mkdirSync(paths.sessionDir('s'), { recursive: true })
		let call = history.append('s', { type: 'assistant', block: { type: 'tool_call', id: 't', name: 'read', input: { path: 'example.txt' } } })
		let result = history.append('s', { type: 'user', blocks: [{ type: 'tool_result', id: 't', output: 'file contents' }] })
		expect((await blobRun(`#${call.n}`)).output).toContain('example.txt')
		expect((await blobRun(`s#${result.n}`)).output).toContain('file contents')
		expect((await blobRun('#999999')).isError).toBe(true)
	} finally { paths.home = originalHome }
})
