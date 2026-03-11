import { test, expect, afterEach } from 'bun:test'
import { executeTool, argsPreview, type ToolCall } from './tools.ts'
import { runHooks } from './hooks.ts'
import { writeFileSync, unlinkSync, mkdirSync } from 'fs'

const TMP = `/tmp/hal-tools-test-${process.pid}`
const call = (name: string, input: any): ToolCall => ({ id: 'test', name, input })

afterEach(() => { try { unlinkSync(`${TMP}.txt`) } catch {} })

// ── bash ──

test('bash: runs command', async () => {
	const result = await executeTool(call('bash', { command: 'echo hello' }))
	expect(result.trim()).toBe('hello')
})

test('bash: reports exit code', async () => {
	const result = await executeTool(call('bash', { command: 'exit 42' }))
	expect(result).toContain('[exit 42]')
})

// ── read ──

test('read: returns hashline format', async () => {
	writeFileSync(`${TMP}.txt`, 'line one\nline two\n')
	const result = await executeTool(call('read', { path: `${TMP}.txt` }))
	expect(result).toContain('1:')
	expect(result).toContain('line one')
	expect(result).toContain('line two')
	// Hashline format: "N:XXX content"
	expect(result).toMatch(/^\d+:[0-9a-zA-Z]{3} /)
})

test('read: supports start/end range', async () => {
	writeFileSync(`${TMP}.txt`, 'a\nb\nc\nd\n')
	const result = await executeTool(call('read', { path: `${TMP}.txt`, start: 2, end: 3 }))
	expect(result).toContain('b')
	expect(result).toContain('c')
	expect(result).not.toContain('a\n') // line 'a' shouldn't appear as content
})

// ── write ──

test('write: creates file', async () => {
	const result = await executeTool(call('write', { path: `${TMP}.txt`, content: 'hello' }))
	expect(result).toBe('ok')
	const content = require('fs').readFileSync(`${TMP}.txt`, 'utf-8')
	expect(content).toBe('hello')
})

// ── edit ──

test('edit: replace with hashline verification', async () => {
	writeFileSync(`${TMP}.txt`, 'aaa\nbbb\nccc\n')
	// First read to get hashlines
	const readResult = await executeTool(call('read', { path: `${TMP}.txt` }))
	// Extract refs for line 2
	const lines = readResult.split('\n')
	const ref2 = lines[1].split(' ')[0] // "2:XXX"
	const result = await executeTool(call('edit', {
		path: `${TMP}.txt`, operation: 'replace',
		start_ref: ref2, end_ref: ref2, new_content: 'BBB',
	}))
	expect(result).toContain('+++ after')
	const content = require('fs').readFileSync(`${TMP}.txt`, 'utf-8')
	expect(content).toBe('aaa\nBBB\nccc\n')
})

test('edit: insert after ref', async () => {
	writeFileSync(`${TMP}.txt`, 'aaa\nccc\n')
	const readResult = await executeTool(call('read', { path: `${TMP}.txt` }))
	const ref1 = readResult.split('\n')[0].split(' ')[0]
	const result = await executeTool(call('edit', {
		path: `${TMP}.txt`, operation: 'insert',
		after_ref: ref1, new_content: 'bbb',
	}))
	expect(result).toContain('+++ after')
	const content = require('fs').readFileSync(`${TMP}.txt`, 'utf-8')
	expect(content).toBe('aaa\nbbb\nccc\n')
})

test('edit: hash mismatch returns error', async () => {
	writeFileSync(`${TMP}.txt`, 'aaa\nbbb\n')
	const result = await executeTool(call('edit', {
		path: `${TMP}.txt`, operation: 'replace',
		start_ref: '1:ZZZ', end_ref: '1:ZZZ', new_content: 'xxx',
	}))
	expect(result).toContain('error:')
	expect(result).toContain('mismatch')
})

// ── grep ──

test('grep: finds matches', async () => {
	writeFileSync(`${TMP}.txt`, 'hello world\nfoo bar\nhello again\n')
	const result = await executeTool(call('grep', { pattern: 'hello', path: `${TMP}.txt` }))
	expect(result).toContain('hello world')
	expect(result).toContain('hello again')
})

test('grep: no matches', async () => {
	writeFileSync(`${TMP}.txt`, 'hello\n')
	const result = await executeTool(call('grep', { pattern: 'zzzzz', path: `${TMP}.txt` }))
	expect(result).toBe('No matches found.')
})

// ── glob ──

test('glob: finds files', async () => {
	mkdirSync(`${TMP}-dir`, { recursive: true })
	writeFileSync(`${TMP}-dir/a.ts`, '')
	writeFileSync(`${TMP}-dir/b.txt`, '')
	const result = await executeTool(call('glob', { pattern: '*.ts', path: `${TMP}-dir` }))
	expect(result).toContain('a.ts')
	expect(result).not.toContain('b.txt')
	// cleanup
	unlinkSync(`${TMP}-dir/a.ts`)
	unlinkSync(`${TMP}-dir/b.txt`)
	require('fs').rmdirSync(`${TMP}-dir`)
})

// ── ls ──

test('ls: lists directory', async () => {
	const result = await executeTool(call('ls', { path: '/tmp', depth: 1 }))
	expect(result.length).toBeGreaterThan(0)
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
	const result = await executeTool(call('bash', { command: `echo ${home}/foo` }))
	expect(result).toContain('~/foo')
	expect(result).not.toContain(home)
})

// ── required parameter validation ──

test('missing required params: read without path', async () => {
	const result = await executeTool(call('read', {}))
	expect(result).toContain('error:')
	expect(result).toContain('path')
})

test('missing required params: write without content', async () => {
	const result = await executeTool(call('write', { path: `${TMP}.txt` }))
	expect(result).toContain('error:')
	expect(result).toContain('content')
})

test('missing required params: bash without command', async () => {
	const result = await executeTool(call('bash', {}))
	expect(result).toContain('error:')
	expect(result).toContain('command')
})

test('missing required params: edit without path', async () => {
	const result = await executeTool(call('edit', { operation: 'replace', new_content: 'x' }))
	expect(result).toContain('error:')
	expect(result).toContain('path')
})

test('missing required params: grep without pattern', async () => {
	const result = await executeTool(call('grep', {}))
	expect(result).toContain('error:')
	expect(result).toContain('pattern')
})

test('missing required params: glob without pattern', async () => {
	const result = await executeTool(call('glob', {}))
	expect(result).toContain('error:')
	expect(result).toContain('pattern')
})

test('edit with empty new_content is allowed (deletion)', async () => {
	writeFileSync(`${TMP}.txt`, 'aaa\nbbb\nccc\n')
	const lines = (await executeTool(call('read', { path: `${TMP}.txt` }))).trim().split('\n')
	const ref2 = lines[1].split(' ')[0] // "2:HASH"
	const result = await executeTool(call('edit', { path: `${TMP}.txt`, operation: 'replace', new_content: '', start_ref: ref2, end_ref: ref2 }))
	expect(result).not.toContain('requires new_content')
})
