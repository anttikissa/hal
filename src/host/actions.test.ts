// Action (task 3fv): the grammar, leases and multi-range EDIT through
// the real tool modules.

import { expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync, chmodSync } from 'fs'
import { replay } from '../common/replay.ts'
import { actions } from './actions.ts'
import { client, created, testHome, useHost } from './host-fixture.test.ts'
import { tools } from './tools.ts'

useHost()

async function act(id: string, text: string): Promise<{ output: string; isError?: boolean }> {
	let call = actions.arrived({ type: 'tool_call', id: 'c', name: 'Action', input: { action: text } })
	return tools.run(call, { cwd: testHome(), signal: new AbortController().signal, sessionId: id })
}
const leaseOf = (out: string) => /@(\w{5})/.exec(out)![1]!

test('arguments: strings, objects, comments as purpose, bare words, slash commands', () => {
	expect(actions.resolve('bash /* Check */ "ls -l" /* it */ { timeout: 2, modifies: ["a.ts"] }')).toEqual({ name: 'bash', input: { command: 'ls -l', timeout: 2000, modifies: ['a.ts'], description: 'Check it' } })
	expect(actions.resolve('# note\n\nREAD "a b.ts":3-')).toEqual({ name: 'read', input: { path: 'a b.ts', offset: 3 } })
	expect(actions.resolve('READ https://example.com/x:80')).toEqual({ name: 'read_url', input: { url: 'https://example.com/x:80' } })
	expect(actions.resolve('/rename Fix it')).toEqual({ name: 'command', input: { command: '/rename Fix it' } })
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
	// Another EDIT of the old lease, as in one round: it overlaps line 8
	// that the first one deleted, so it fails, showing the current lines.
	let stale = await act(id, `EDIT "a.txt@${h}" { range: "5-8", lines: ["x"] }`)
	expect(stale.isError).toBe(true)
	expect(stale.output).toContain(`== EDIT a.txt@${lease(path)}:5-8 failed (lines 5-8 overlap lines 8-8 that an EDIT of @${h} already changed; nothing was written) ==\n3: 2.5\n4: three\n5: 4\n6: 5\n7: 6\n8: 7\n9: 9\n10: 10`)
	// Ranges that miss earlier changes move with them, across several EDITs.
	await act(id, `EDIT "a.txt@${h}" { range: 5, lines: ["five"] }`)
	await act(id, `EDIT "a.txt@${h}" { range: "10-11", lines: ["ten"] }`)
	expect(readFileSync(path, 'utf8')).toBe('1\ntwo\n2.5\nthree\n4\nfive\n6\n7\n9\nten\n12\n13\nend\n')
	// A change outside Hal breaks the chain: the old lease is just stale.
	writeFileSync(path, readFileSync(path, 'utf8') + 'x\n')
	expect((await act(id, `EDIT "a.txt@${h}" { range: 1, lines: ["y"] }`)).output).toContain(`failed (file has been modified since @${h})`)
	let before = readFileSync(path, 'utf8')
	let overlap = await act(id, `EDIT "a.txt@${lease(path)}" { range: "1-2", lines: ["a"] } { range: "2-3", lines: ["b"] }`)
	expect(overlap.output).toContain('overlap')
	expect(readFileSync(path, 'utf8')).toBe(before)
	expect((await act(id, `EDIT "a.txt@${lease(path)}" { range: 1, lines: ["1"] }`)).output).toContain('unchanged')
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

test('HELP comes from the tool modules; $tools_summary lists only tools the prompt does not explain', async () => {
	let id = created(client(), testHome())
	let help = (await act(id, 'HELP bash')).output
	expect(help).toContain('BASH [/* purpose */] "<command>"')
	expect(help).toContain('timeout (integer): Seconds')
	expect((await act(id, 'HELP')).output).toContain('EDIT [/* purpose */]')
	let summary = actions.summary()
	expect(summary).toContain('\tWAIT for a child report')
	expect(summary).not.toContain('BASH')
})

const lease = (path: string) => leaseOf(`@${require('./lease.ts').lease.hash(readFileSync(path))}`)
