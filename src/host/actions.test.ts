// Action (task 3fv): the grammar, leases and multi-range EDIT through
// the real tool modules.

import { expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'fs'
import { relative } from 'path'
import { fileChanges } from './file-changes.ts'
import { history } from './history.ts'
import { replay } from '../common/replay.ts'
import { actions } from './actions.ts'
import { client, created, testHome, useHost } from './host-fixture.test.ts'
import { tools } from './tools.ts'
import { edit } from './tools/edit.ts'

useHost()

async function act(id: string, text: string): Promise<{ output: string; isError?: boolean }> {
	let call = actions.arrived({ type: 'tool_call', id: 'c', name: 'Action', input: { action: text } })
	return tools.run(call, { cwd: testHome(), signal: new AbortController().signal, sessionId: id })
}
const leaseOf = (out: string) => /@(\w{5})/.exec(out)![1]!

test('shared help and ordinary validation do not teach purpose comments', async () => {
	let id = created(client(), testHome())
	for (let text of ['HELP', 'HELP BASH', 'HELP EDIT', 'BASH', 'EDIT', 'BASH "true" { unknown: 1 }']) {
		let result = await act(id, text)
		expect(result.output).not.toContain('/*')
		expect(result.output).toContain(text.startsWith('HELP') ? text.slice(5) || 'BASH' : 'Usage:')
	}
	expect(JSON.stringify(actions.def())).not.toContain('/*')
})

test('arguments: strings, objects, comments as purpose, bare words, COMMAND', () => {
	expect(actions.resolve('bash /* Check */ "ls -l" /* it */ { timeout: 2, modifies: ["a.ts"] }')).toEqual({ name: 'bash', input: { command: 'ls -l', timeout: 2000, modifies: ['a.ts'], description: 'Check it' } })
	expect(actions.resolve('# note\n\nREAD "a b.ts":3-')).toEqual({ name: 'read', input: { path: 'a b.ts', offset: 3 } })
	expect(actions.resolve('READ https://example.com/x:80')).toEqual({ name: 'read_url', input: { url: 'https://example.com/x:80' } })
	expect(actions.resolve('COMMAND /rename Fix it')).toEqual({ name: 'command', input: { command: '/rename Fix it' } })
	expect(actions.resolve('HELP edit')).toEqual({ name: 'help', input: { name: 'edit' } })
	// An unclosed comment ends at its line, but never stands in for arguments.
	expect(actions.resolve('BASH "ls" /* list')).toEqual({ name: 'bash', input: { command: 'ls', description: 'list' } })
	expect(() => actions.resolve('EDIT /* fix "a.ts@abcde" { range: 1, lines: [] }')).toThrow(/unclosed/)
	expect(() => actions.resolve('ls -l')).toThrow(/unknown action LS/)
	expect(() => actions.resolve('READ a.ts\nREAD b.ts')).toThrow(/one action per call/)
	expect(() => actions.resolve('BASH "ls" { evil: 1 }')).toThrow(/no field 'evil'/)
	expect(() => actions.resolve('BASH "x" { timeout: 1 + 2 }')).toThrow()
})

test('replay sends calls back as Action text, old calls as their equivalent', () => {
	expect(replay.asAction({ type: 'tool_call', id: 'a', name: 'bash', input: { command: 'ls' }, action: 'BASH "ls"' }).input).toEqual({ action: 'BASH "ls"' })
	expect(replay.asAction({ type: 'tool_call', id: 'a', name: 'read', input: { path: 'x' } }).input).toEqual({ action: "READ { path: 'x' }" })
})

test('READ leases the whole file; ranges clamp; EDIT applies every range to the leased version at once', async () => {
	let id = created(client(), testHome())
	let path = `${testHome()}/a.txt`
	writeFileSync(path, Array.from({ length: 13 }, (_, i) => `${i + 1}\n`).join(''))
	chmodSync(path, 0o751)
	let whole = (await act(id, 'READ a.txt')).output
	let h = leaseOf(whole)
	expect((await act(id, 'READ "a.txt:0-15"')).output).toBe(whole)
	expect((await act(id, 'READ "a.txt:12-"')).output).toBe(`== READ a.txt@${h} ==\n12: 12\n13: 13`)
	expect((await act(id, 'READ "a.txt:15-14"')).output).toBe(`== READ a.txt@${h} ==\n[Empty range: the file has 13 lines]`)
	let edit = await act(id, `EDIT "a.txt@${h}" { range: "2-3", lines: ["two", "2.5", "three"] } { range: 8, lines: [] } { range: "20-21", lines: ["end"] }`)
	expect(readFileSync(path, 'utf8')).toBe('1\ntwo\n2.5\nthree\n4\n5\n6\n7\n9\n10\n11\n12\n13\nend\n')
	expect(statSync(path).mode & 0o777).toBe(0o751)
	// Context in final numbering: around each start and end, merged.
	expect(edit.output).toBe(`== EDIT a.txt@${lease(path)} ok: ==\n1: 1\n2: two\n…\n4: three\n5: 4\n6: 5\n7: 6\n8: 7\n9: 9\n10: 10\n…\n12: 12\n13: 13\n14: end`)
	// The old lease is stale even though these lines did not change.
	let stale = await act(id, `EDIT "a.txt@${h}" { range: "5-8", lines: ["x"] }`)
	expect(stale.isError).toBe(true)
	expect(stale.output).toContain(`== EDIT a.txt@${lease(path)}:5-8 failed (file has been modified since @${h}) ==\n3: 2.5\n4: three\n5: 4\n6: 5\n7: 6\n8: 7\n9: 9\n10: 10`)
	let before = readFileSync(path, 'utf8')
	let overlap = await act(id, `EDIT "a.txt@${lease(path)}" { range: "1-2", lines: ["a"] } { range: "2-3", lines: ["b"] }`)
	expect(overlap.output).toContain('overlap')
	expect(readFileSync(path, 'utf8')).toBe(before)
	expect((await act(id, `EDIT "a.txt@${lease(path)}" { range: 1, lines: ["1"] }`)).output).toContain('unchanged')
})

test("a round's EDITs of one lease run as one write; an overlap fails them all", async () => {
	let id = created(client(), testHome())
	let path = `${testHome()}/r.txt`
	writeFileSync(path, 'a\nb\nc\nd\n')
	let ctx = { cwd: testHome(), signal: new AbortController().signal, sessionId: id }
	let round = async (...texts: string[]) => {
		let calls = texts.map((t, i) => ({ ...actions.arrived({ type: 'tool_call', id: `c${i}`, name: 'Action', input: { action: t } }), id: `c${i}` }))
		let run = await edit.batch(calls, testHome(), id, (c) => tools.run(c, ctx))
		return Promise.all(calls.map(run))
	}
	let h = lease(path)
	// Same file through another spelling; the first call grows the file.
	let done = await round(`EDIT "r.txt@${h}" { range: 1, lines: ["A", "A2"] }`, `EDIT "./r.txt@${h}" { range: 4, lines: ["D"] }`)
	expect(readFileSync(path, 'utf8')).toBe('A\nA2\nb\nc\nD\n')
	expect(done.map((r) => r.id)).toEqual(['c0', 'c1'])
	expect(done[1]!.output).toContain('2 EDITs of r.txt@')
	expect(done.every((r) => !r.isError)).toBe(true)
	let before = readFileSync(path, 'utf8')
	let clash = await round(`EDIT "r.txt@${lease(path)}" { range: "1-2", lines: ["x"] }`, `EDIT "r.txt@${lease(path)}" { range: 2, lines: ["y"] }`)
	expect(clash.every((r) => r.isError && r.output.includes('overlap'))).toBe(true)
	expect(readFileSync(path, 'utf8')).toBe(before)
	// A lease replaced in an earlier round stays stale.
	expect((await round(`EDIT "r.txt@${h}" { range: 3, lines: ["z"] }`))[0]!.output).toContain('modified since')
})

test('EDIT keeps CRLF, a BOM and a missing final newline; WRITE creates directories', async () => {
	let id = created(client(), testHome())
	let path = `${testHome()}/w.txt`
	writeFileSync(path, '\uFEFFa\r\nb\r\nc')
	await act(id, `EDIT "w.txt@${lease(path)}" { range: 2, lines: ["B", "B2"] } { range: 9, lines: ["d"] }`)
	expect(readFileSync(path, 'utf8')).toBe('\uFEFFa\r\nB\r\nB2\r\nc\r\nd')
	let written = await act(id, 'WRITE "deep/new.txt" "x\\ny\\n"')
	expect(written.output).toBe(`== WRITE deep/new.txt@${lease(`${testHome()}/deep/new.txt`)} ok: 2 lines, 4 bytes ==`)
})

test('file Actions work outside tracking scope and snapshot eligible literal filenames', async () => {
	let id = created(client(), testHome())
	let dir = mkdtempSync(`${process.cwd()}/.hal-actions-`)
	let path = `${dir}/deep/file[1].txt`
	try {
		let written = await act(id, `WRITE ${JSON.stringify(path)} ${JSON.stringify('old\n')}`)
		expect(written.isError).toBeUndefined()
		let read = await act(id, `READ ${JSON.stringify(path)}`)
		expect(read.output).toContain('1: old')
		let parent = relative(testHome(), path)
		let edited = await act(id, `EDIT ${JSON.stringify(`${parent}@${leaseOf(read.output)}`)} { range: 1, lines: ['new'] }`)
		expect(edited.isError).toBeUndefined()
		expect(readFileSync(path, 'utf8')).toBe('new\n')
		let stale = await act(id, `EDIT ${JSON.stringify(`${path}@${leaseOf(read.output)}`)} { range: 1, lines: ['bad'] }`)
		expect(stale.isError).toBe(true)
		expect(readFileSync(path, 'utf8')).toBe('new\n')
		expect(history.readSync(id).filter((r) => r.type === 'file_changes')).toHaveLength(0)
		let literal = `${testHome()}/file[1].txt`
		expect((await act(id, `WRITE ${JSON.stringify(literal)} 'tracked'`)).isError).toBeUndefined()
		let recorded = history.readSync(id).findLast((r) => r.type === 'file_changes')!
		if (recorded.type !== 'file_changes') throw new Error('missing file changes')
		expect(recorded.files).toMatchObject([{ path: literal, before: null }])
		expect(readFileSync(fileChanges.blobPath(id, recorded.files[0]!.after as string), 'utf8')).toBe('tracked')
		for (let name of ['WRITE', 'EDIT']) {
			let bad = await act(id, name === 'WRITE' ? `WRITE ${JSON.stringify('bad\0path')} 'x'` : `EDIT ${JSON.stringify('bad\0path@abcde')} { range: 1, lines: [] }`)
			expect(bad.isError).toBe(true)
			expect(bad.output).toContain('NUL')
		}
		let secret = `${testHome()}/.env`
		expect((await act(id, `WRITE ${JSON.stringify(secret)} 'private'`)).isError).toBeUndefined()
		let sensitive = history.readSync(id).findLast((r) => r.type === 'file_changes')!
		if (sensitive.type !== 'file_changes') throw new Error('missing file changes')
		expect(sensitive.files[0]).toMatchObject({ path: secret, before: null, after: { size: 7 } })
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('HELP comes from the tool modules; $tools_summary lists only tools the prompt does not explain', async () => {
	let id = created(client(), testHome())
	let help = (await act(id, 'HELP bash')).output
	expect(help).toContain('BASH "<command>"')
	expect(help).toContain('timeout (integer): Seconds')
	expect((await act(id, 'HELP')).output).toContain('EDIT "<path>@<hash>"')
	let summary = actions.summary()
	expect(summary).toContain('\tWAIT for a child report')
	expect(summary).not.toContain('BASH')
})

const lease = (path: string) => leaseOf(`@${require('./lease.ts').lease.hash(readFileSync(path))}`)
