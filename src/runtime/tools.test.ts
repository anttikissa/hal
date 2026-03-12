import { test, expect, afterEach, afterAll } from 'bun:test'
import { executeTool, argsPreview, getTools, type ToolCall, tools } from './tools.ts'
import { runHooks } from './hooks.ts'
import { writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync } from 'fs'
import { blob } from '../session/blob.ts'
import { state } from '../state.ts'

const TMP = `/tmp/hal-tools-test-${process.pid}`
const call = (name: string, input: any): ToolCall => ({ id: 'test', name, input })
const textResult = async (name: string, input: any, ctx?: any) => {
	const result = await executeTool(call(name, input), undefined, ctx)
	expect(typeof result).toBe('string')
	return result as string
}

const defaultConfig = {
	maxOutput: tools.config.maxOutput,
	contextLines: tools.config.contextLines,
}

afterEach(() => {
	tools.config.maxOutput = defaultConfig.maxOutput
	tools.config.contextLines = defaultConfig.contextLines
	try { unlinkSync(`${TMP}.txt`) } catch {}
	try { rmSync(`${TMP}-dir`, { recursive: true, force: true }) } catch {}
})

const BLOB_TEST_SESSIONS = ['__tools_blob_read__', '__tools_blob_image__']
afterAll(() => {
	for (const id of BLOB_TEST_SESSIONS) {
		rmSync(state.sessionDir(id), { recursive: true, force: true })
	}
})

test('truncate uses live config by default', () => {
	tools.config.maxOutput = 3
	expect(tools.truncate('abcdef')).toBe('abc\n[truncated 3 chars]')
})

// ── bash ──

test('bash: runs command', async () => {
	const result = await textResult('bash', { command: 'echo hello' })
	expect(result.trim()).toBe('hello')
})

test('bash: reports exit code', async () => {
	const result = await textResult('bash', { command: 'exit 42' })
	expect(result).toContain('[exit 42]')
})

// ── read ──

test('read: returns hashline format', async () => {
	writeFileSync(`${TMP}.txt`, 'line one\nline two\n')
	const result = await textResult('read', { path: `${TMP}.txt` })
	expect(result).toContain('1:')
	expect(result).toContain('line one')
	expect(result).toContain('line two')
	expect(result).toMatch(/^\d+:[0-9a-zA-Z]{3} /)
})

test('read: supports start/end range', async () => {
	writeFileSync(`${TMP}.txt`, 'a\nb\nc\nd\n')
	const result = await textResult('read', { path: `${TMP}.txt`, start: 2, end: 3 })
	expect(result).toContain('b')
	expect(result).toContain('c')
	expect(result).not.toContain('a\n')
})

// ── write ──

test('write: creates file', async () => {
	const result = await textResult('write', { path: `${TMP}.txt`, content: 'hello' })
	expect(result).toBe('ok')
	const content = require('fs').readFileSync(`${TMP}.txt`, 'utf-8')
	expect(content).toBe('hello')
})

// ── edit ──

test('edit: replace with hashline verification', async () => {
	writeFileSync(`${TMP}.txt`, 'aaa\nbbb\nccc\n')
	const readResult = await textResult('read', { path: `${TMP}.txt` })
	const lines = readResult.split('\n')
	const ref2 = lines[1].split(' ')[0]
	const result = await textResult('edit', {
		path: `${TMP}.txt`,
		operation: 'replace',
		start_ref: ref2,
		end_ref: ref2,
		new_content: 'BBB',
	})
	expect(result).toContain('+++ after')
	const content = require('fs').readFileSync(`${TMP}.txt`, 'utf-8')
	expect(content).toBe('aaa\nBBB\nccc\n')
})

test('edit: insert after ref', async () => {
	writeFileSync(`${TMP}.txt`, 'aaa\nccc\n')
	const readResult = await textResult('read', { path: `${TMP}.txt` })
	const ref1 = readResult.split('\n')[0].split(' ')[0]
	const result = await textResult('edit', {
		path: `${TMP}.txt`,
		operation: 'insert',
		after_ref: ref1,
		new_content: 'bbb',
	})
	expect(result).toContain('+++ after')
	const content = require('fs').readFileSync(`${TMP}.txt`, 'utf-8')
	expect(content).toBe('aaa\nbbb\nccc\n')
})

test('edit: hash mismatch returns error', async () => {
	writeFileSync(`${TMP}.txt`, 'aaa\nbbb\n')
	const result = await textResult('edit', {
		path: `${TMP}.txt`,
		operation: 'replace',
		start_ref: '1:ZZZ',
		end_ref: '1:ZZZ',
		new_content: 'xxx',
	})
	expect(result).toContain('error:')
	expect(result).toContain('mismatch')
})

// ── grep ──

test('grep: finds matches', async () => {
	writeFileSync(`${TMP}.txt`, 'hello world\nfoo bar\nhello again\n')
	const result = await textResult('grep', { pattern: 'hello', path: `${TMP}.txt` })
	expect(result).toContain('hello world')
	expect(result).toContain('hello again')
})

test('grep: no matches', async () => {
	writeFileSync(`${TMP}.txt`, 'hello\n')
	const result = await textResult('grep', { pattern: 'zzzzz', path: `${TMP}.txt` })
	expect(result).toBe('No matches found.')
})

// ── glob ──

test('glob: finds files', async () => {
	mkdirSync(`${TMP}-dir`, { recursive: true })
	writeFileSync(`${TMP}-dir/a.ts`, '')
	writeFileSync(`${TMP}-dir/b.txt`, '')
	const result = await textResult('glob', { pattern: '*.ts', path: `${TMP}-dir` })
	expect(result).toContain('a.ts')
	expect(result).not.toContain('b.txt')
})

// ── ls ──

test('ls: lists directory', async () => {
	const result = await textResult('ls', { path: '/tmp', depth: 1 })
	expect(result.length).toBeGreaterThan(0)
})

// ── read_blob ──

test('read_blob: reads tool blobs by id', async () => {
	const sessionId = '__tools_blob_read__'
	const blobId = blob.makeId(sessionId)
	await blob.write(sessionId, blobId, { call: { name: 'bash', input: { command: 'pwd' } } })
	const result = await textResult('read_blob', { blobId }, { sessionId })
	expect(result).toContain('bash')
	expect(result).toContain('pwd')
})

test('read_blob: summarizes image blobs', async () => {
	const sessionId = '__tools_blob_image__'
	const blobId = blob.makeId(sessionId)
	await blob.write(sessionId, blobId, { media_type: 'image/png', data: 'AAAA' })
	const result = await textResult('read_blob', { blobId }, { sessionId })
	expect(result).toContain(`blob ${blobId}`)
	expect(result).toContain('kind: image')
})


test('tool schema: read_blob explains blob placeholders', () => {
	const tool = getTools(false).find(t => t.name === 'read_blob')
	expect(tool).toBeTruthy()
	expect(tool.description).toContain('blob <id>')
	expect(tool.input_schema.properties.blobId.description).toContain('thinking blob')
})

// ── argsPreview ──

test('argsPreview: bash', () => {
	expect(argsPreview(call('bash', { command: 'ls -la' }))).toBe('ls -la')
})

test('argsPreview: edit', () => {
	expect(argsPreview(call('edit', { path: 'foo.ts' }))).toBe('foo.ts')
})

test('argsPreview: replaces $HOME with ~', () => {
	const home = require('os').homedir()
	expect(argsPreview(call('read', { path: `${home}/.hal/foo.ts` }))).toBe('~/.hal/foo.ts')
	expect(argsPreview(call('write', { path: `${home}/projects/bar.ts` }))).toBe('~/projects/bar.ts')
	expect(argsPreview(call('edit', { path: `${home}/x.ts` }))).toBe('~/x.ts')
	expect(argsPreview(call('ls', { path: `${home}/dir` }))).toBe('~/dir')
	expect(argsPreview(call('read_blob', { blobId: 'abc123' }))).toBe('abc123')
})

// ── hooks ──

test('runHooks: strips redundant cd $CWD prefix', () => {
	const cwd = process.env.LAUNCH_CWD ?? process.cwd()
	const result = runHooks(call('bash', { command: `cd ${cwd} && echo hello` }))
	expect((result.input as any).command).toBe('echo hello')
})

test('runHooks: strips cd with ~ when it resolves to CWD', () => {
	const home = require('os').homedir()
	const cwd = process.env.LAUNCH_CWD ?? process.cwd()
	if (cwd.startsWith(home)) {
		const tilded = '~' + cwd.slice(home.length)
		const result = runHooks(call('bash', { command: `cd ${tilded} && echo hello` }))
		expect((result.input as any).command).toBe('echo hello')
	}
})

test('runHooks: keeps cd to different directory', () => {
	const result = runHooks(call('bash', { command: 'cd /tmp && pwd' }))
	expect((result.input as any).command).toBe('cd /tmp && pwd')
})

test('runHooks: no-op for non-bash tools', () => {
	const result = runHooks(call('read', { path: '/tmp/foo' }))
	expect((result.input as any).path).toBe('/tmp/foo')
})

// ── shortenHome ──

test('output replaces $HOME with ~', async () => {
	const home = require('os').homedir()
	const result = await textResult('bash', { command: `echo ${home}/foo` })
	expect(result).toContain('~/foo')
	expect(result).not.toContain(home)
})

// ── required parameter validation ──

test('missing required params: read without path', async () => {
	const result = await textResult('read', {})
	expect(result).toContain('error:')
	expect(result).toContain('path')
})

test('missing required params: write without content', async () => {
	const result = await textResult('write', { path: `${TMP}.txt` })
	expect(result).toContain('error:')
	expect(result).toContain('content')
})

test('missing required params: bash without command', async () => {
	const result = await textResult('bash', {})
	expect(result).toContain('error:')
	expect(result).toContain('command')
})

test('missing required params: edit without path', async () => {
	const result = await textResult('edit', { operation: 'replace', new_content: 'x' })
	expect(result).toContain('error:')
	expect(result).toContain('path')
})

test('missing required params: grep without pattern', async () => {
	const result = await textResult('grep', {})
	expect(result).toContain('error:')
	expect(result).toContain('pattern')
})

test('missing required params: glob without pattern', async () => {
	const result = await textResult('glob', {})
	expect(result).toContain('error:')
	expect(result).toContain('pattern')
})

test('missing required params: read_blob without blobId', async () => {
	const result = await textResult('read_blob', {}, { sessionId: '__tools_blob_missing__' })
	expect(result).toContain('error:')
	expect(result).toContain('blobId')
})

test('edit with empty new_content is allowed (deletion)', async () => {
	writeFileSync(`${TMP}.txt`, 'aaa\nbbb\nccc\n')
	const lines = (await textResult('read', { path: `${TMP}.txt` })).trim().split('\n')
	const ref2 = lines[1].split(' ')[0]
	const result = await textResult('edit', { path: `${TMP}.txt`, operation: 'replace', new_content: '', start_ref: ref2, end_ref: ref2 })
	expect(result).not.toContain('requires new_content')
})
