// The native tool (task 3fv): the grammar, READ versions and block-format
// EDIT through the real tool modules.

import { expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'fs'
import { relative } from 'path'
import { fileChanges } from './file-changes.ts'
import { history } from './history.ts'
import { replay } from '../common/replay.ts'
import { nativeTool } from './native-tool.ts'
import { client, created, testHome, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { tools } from './tools.ts'

useHost()

async function act(id: string, text: string): Promise<{ output: string; isError?: boolean }> {
	let call = nativeTool.arrived({ type: 'tool_call', id: 'c', name: 'tool', input: { cmd: text } })
	return tools.run(call, { cwd: testHome(), signal: new AbortController().signal, sessionId: id })
}
const versionOf = (out: string) => /@(\w{5})/.exec(out)![1]!

test('only interactive HELP teaches purpose comments; validation never does', async () => {
	let id = created(client(), testHome())
	expect((await act(id, 'HELP')).output).toContain('/* <description> */')
	expect((await act(id, 'HELP')).output).toContain('BASH /* <description> */ "<command>"')
	expect((await act(id, 'HELP bash')).output).toContain('BASH /* <description> */ "<command>"')
	sessions.open(id).interactive = false
	for (let text of ['HELP', 'HELP BASH', 'HELP EDIT', 'BASH', 'EDIT', 'BASH "true" { unknown: 1 }']) {
		let result = await act(id, text)
		expect(result.output).not.toContain('/*')
		expect(result.output).toContain(text.startsWith('HELP') ? text.slice(5) || 'BASH' : text === 'EDIT' ? 'at least one operation' : 'Usage:')
	}
	expect(JSON.stringify(nativeTool.def())).not.toContain('/*')
})

test('arguments: strings, objects, comments as purpose, bare words, COMMAND', () => {
	expect(nativeTool.resolve('bash /* Check */ "ls -l" /* it */ { timeout: 2, modifies: ["a.ts"] }')).toEqual({ name: 'bash', input: { command: 'ls -l', timeout: 2, modifies: ['a.ts'], description: 'Check it' } })
	expect(nativeTool.resolve('# note\n\nREAD "a b.ts":3-')).toEqual({ name: 'read', input: { path: 'a b.ts', offset: 3 } })
	expect(nativeTool.resolve('READ https://example.com/x:80')).toEqual({ name: 'read', input: { url: 'https://example.com/x:80' } })
	expect(nativeTool.resolve('COMMAND /rename Fix it')).toEqual({ name: 'command', input: { command: '/rename Fix it' } })
	expect(nativeTool.resolve('HELP edit')).toEqual({ name: 'help', input: { name: 'edit' } })
	// An unclosed comment ends at its line, but never stands in for arguments.
	expect(nativeTool.resolve('BASH "ls" /* list')).toEqual({ name: 'bash', input: { command: 'ls', description: 'list' } })
	expect(() => nativeTool.resolve('EDIT /* fix "a.ts@abcde" { range: 1, lines: [] }')).toThrow(/unclosed/)
	expect(() => nativeTool.resolve('ls -l')).toThrow(/unknown tool LS/)
	expect(() => nativeTool.resolve('READ a.ts\nREAD b.ts')).toThrow(/one tool per call/)
	expect(() => nativeTool.resolve('BASH "ls" { evil: 1 }')).toThrow(/no field 'evil'/)
	// Every tool takes an optional purpose: a comment or a description field, even where the tool keeps none.
	expect(nativeTool.resolve('SEND "2" "hi"')).toEqual({ name: 'send', input: { to: '2', text: 'hi' } })
	expect(nativeTool.resolve('SEND /* Ask */ "2" "hi"')).toEqual({ name: 'send', input: { to: '2', text: 'hi', description: 'Ask' } })
	expect(nativeTool.resolve('NOTIFY /* Ping */ "done" { description: "Ping" }')).toEqual({ name: 'notify', input: { text: 'done' } })
	// Field names and forms models were seen to send, accepted silently.
	expect(nativeTool.resolve('SPAWN [{ title: "x", goal: "y" }]')).toEqual({ name: 'spawn', input: { name: 'x', task: 'y' } })
	expect(() => nativeTool.resolve('SPAWN [{ name: "one", task: "x" }, { name: "two", task: "y" }]')).toThrow('SPAWN takes 0 plain arguments, got another: [{"name":"one","task":"x"},{"name":"two","task":"y"}]. Usage: SPAWN { task, [ kind, mode, model, cwd, name, limit ] }       // "[ ]" here means optional, not an array')
	expect(nativeTool.resolve('SEND { session: "2", text: "hi" }')).toEqual({ name: 'send', input: { to: '2', text: 'hi' } })
	expect(nativeTool.resolve('BASH { cmd: "ls" }')).toEqual({ name: 'bash', input: { command: 'ls' } })
	expect(nativeTool.resolve('WAIT { for: ["09-ada"], timeout: 60 }')).toEqual({ name: 'wait', input: { targets: ['09-ada'] } })
	expect(nativeTool.resolve('INSPECT sessions all "tab,id"')).toEqual({ name: 'inspect', input: { what: 'sessions', scope: 'all', fields: 'tab,id' } })
	expect(nativeTool.resolve('READ "a.ts" "b.ts:3-4"')).toEqual({ name: 'read', input: { paths: [{ path: 'a.ts' }, { path: 'b.ts', offset: 3, limit: 2 }] } })
	expect(nativeTool.resolve('/rename System prompt token count')).toEqual({ name: 'command', input: { command: '/rename System prompt token count' } })
	expect(() => nativeTool.resolve('BASH "x" { timeout: 1 + 2 }')).toThrow()
})

test('replay sends calls back as their cmd text, old calls as their equivalent', () => {
	expect(replay.asNative({ type: 'tool_call', id: 'a', name: 'bash', input: { command: 'ls' }, cmd: 'BASH "ls"' }).input).toEqual({ cmd: 'BASH "ls"' })
	expect(replay.asNative({ type: 'tool_call', id: 'a', name: 'read', input: { path: 'x' } }).input).toEqual({ cmd: "READ { path: 'x' }" })
})

test('READ shows the whole file version; ranges clamp', async () => {
	let id = created(client(), testHome())
	let path = `${testHome()}/a.txt`
	writeFileSync(path, Array.from({ length: 13 }, (_, i) => `${i + 1}\n`).join(''))
	let whole = (await act(id, 'READ a.txt')).output
	let h = versionOf(whole)
	expect((await act(id, 'READ "a.txt:0-15"')).output).toBe(whole)
	expect((await act(id, 'READ "a.txt:12-"')).output).toBe(`== READ a.txt@${h} ==\n12: 12\n13: 13`)
	expect((await act(id, 'READ "a.txt:15-14"')).output).toBe(`== READ a.txt@${h} ==\n[Empty range: the file has 13 lines]`)
})

test('EDIT keeps CRLF, a BOM, a missing final newline and the mode; create makes directories', async () => {
	let id = created(client(), testHome())
	let path = `${testHome()}/w.txt`
	writeFileSync(path, '\uFEFFa\r\nb\r\nc')
	chmodSync(path, 0o751)
	let v = version(path)
	await act(id, `EDIT\nw.txt@${v} replace 2-2\n!!NEW\nB\nB2\n!!END\nw.txt@${v} insert-after 3\n!!NEW\nd\n!!END`)
	expect(readFileSync(path, 'utf8')).toBe('\uFEFFa\r\nB\r\nB2\r\nc\r\nd')
	expect(statSync(path).mode & 0o777).toBe(0o751)
	expect((await act(id, 'EDIT\ndeep/new.txt create\n!!NEW\nx\ny\n!!END')).isError).toBeUndefined()
	expect(readFileSync(`${testHome()}/deep/new.txt`, 'utf8')).toBe('x\ny\n')
})

test('file tools work outside tracking scope and snapshot eligible literal filenames', async () => {
	let id = created(client(), testHome())
	let dir = mkdtempSync(`${process.cwd()}/.hal-tools-`)
	let path = `${dir}/deep/file[1].txt`
	try {
		let create = (p: string, text: string) => act(id, `EDIT\n${p} create\n!!NEW\n${text}\n!!END`)
		let written = await create(path, 'old')
		expect(written.isError).toBeUndefined()
		let read = await act(id, `READ ${JSON.stringify(path)}`)
		expect(read.output).toContain('1: old')
		let parent = relative(testHome(), path)
		let edited = await act(id, `EDIT\n${parent}@${versionOf(read.output)} replace 1-1\n!!NEW\nnew\n!!END`)
		expect(edited.isError).toBeUndefined()
		expect(readFileSync(path, 'utf8')).toBe('new\n')
		let stale = await act(id, `EDIT\n${path}@${versionOf(read.output)} replace 1-1\n!!NEW\nbad\n!!END`)
		expect(stale.isError).toBe(true)
		expect(readFileSync(path, 'utf8')).toBe('new\n')
		expect(history.readSync(id).filter((r) => r.type === 'file_changes')).toHaveLength(0)
		let literal = `${testHome()}/file[1].txt`
		expect((await create(literal, 'tracked')).isError).toBeUndefined()
		let recorded = history.readSync(id).findLast((r) => r.type === 'file_changes')!
		if (recorded.type !== 'file_changes') throw new Error('missing file changes')
		expect(recorded.files).toMatchObject([{ path: literal, before: null }])
		expect(readFileSync(fileChanges.blobPath(id, recorded.files[0]!.after as string), 'utf8')).toBe('tracked\n')
		let bad = await create('bad\0path', 'x')
		expect(bad.isError).toBe(true)
		expect(bad.output).toContain('NUL')
		let secret = `${testHome()}/.env`
		expect((await create(secret, 'private')).isError).toBeUndefined()
		let sensitive = history.readSync(id).findLast((r) => r.type === 'file_changes')!
		if (sensitive.type !== 'file_changes') throw new Error('missing file changes')
		expect(sensitive.files[0]).toMatchObject({ path: secret, before: null, after: { size: 8 } })
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('HELP comes from the tool modules; $tools_summary lists only tools the prompt does not explain', async () => {
	let id = created(client(), testHome())
	let help = (await act(id, 'HELP bash')).output
	expect(help).toContain('BASH /* <description> */ "<command>"')
	expect(help).toContain('timeout (number): Seconds')
	expect((await act(id, 'HELP')).output).toContain('EDIT /* <description> */')
	let summary = nativeTool.summary()
	for (let name of ['SPAWN', 'WAIT', 'STOP', 'BASH']) expect(summary).not.toContain(name)
	expect(summary).toContain('SEND')
	let agents = (await act(id, 'HELP subagents')).output
	expect(agents).toContain('subagent-leave-open')
	expect(agents).toContain('/resume')
	let spawnHelp = (await act(id, 'HELP SPAWN')).output
	expect(spawnHelp).toContain('SPAWN { task, [ kind, mode, model, cwd, name, limit ] }')
	let googleHelp = (await act(id, 'HELP GOOGLE')).output
	expect(googleHelp).toContain('GOOGLE "search terms" [ { num: 5 } ]')
	expect(googleHelp).toContain('num (integer, default 5)')
	expect(nativeTool.usage({ ...nativeTool.find('wait'), syntax: undefined })).toEqual(['WAIT [ { targets } ]'])
})

const version = (path: string) => require('./file-text.ts').fileText.hash(readFileSync(path)) as string
