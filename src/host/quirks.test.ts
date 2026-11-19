// Quirks (task hq6): calls outside the advertised syntax that resolve
// anyway, for every model, and the ones that keep their strict error.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { nativeTool } from './native-tool.ts'
import { diag } from './diag.ts'
import { testHome, useHost } from './host-fixture.test.ts'

useHost()

const ctx = () => ({ cwd: testHome(), sessionId: 's1', model: 'openai/gpt-6.1-sol' })
const resolve = (text: string) => nativeTool.resolve(text, ctx())
const input = (text: string) => resolve(text).input
const fails = (text: string) => expect(() => resolve(text)).toThrow()

const head = ['EDIT', 'a replace', '!!OLD', 'x', '!!NEW', 'y', '!!END']
const edits = [{ path: 'a', old: 'x', new: 'y' }]
const edit = (tail: string[]) => input([...head, ...tail].join('\n'))

test('EDIT quirks rescue the recorded slips for any model and log each firing', () => {
	mkdirSync(dirname(diag.file()), { recursive: true })
	expect(edit(['$ npm test 2>&1 | tail -15', '$ echo "ok"'])).toEqual({
		edits,
		then: ['BASH "npm test 2>&1 | tail -15"', 'BASH "echo \\"ok\\""'],
	})
	expect(edit(['<invoke name="tool">', '<parameter name="cmd">BASH "npm test"</parameter>', '</invoke>'])).toEqual({
		edits,
		then: ['BASH "npm test"'],
	})
	expect(edit(['approve', 'BASH "npm test"'])).toEqual({ edits, then: ['BASH "npm test"'] })
	expect(edit(['That', '!!END'])).toEqual({ edits })
	expect(edit(['EDIT', '<br>', '!!END'])).toEqual({ edits })
	expect(edit(['READ'])).toEqual({ edits })
	expect(edit(['f.ts replace', '!!OLD', '!!NEW', '!!END'])).toEqual({ edits })
	expect(edit(['f.ts@ replace 1-1', '!!NEW', 'z', '!!END'])).toEqual({
		edits: [...edits, { path: 'f.ts', range: '1-1', lines: ['z'] }],
	})
	expect(edit(['f.ts@abc insert after 2', '!!NEW', 'z', '!!END'])).toEqual({
		edits: [...edits, { path: 'f.ts', hash: 'abc', insert: 3, lines: ['z'] }],
	})
	let pairs = [
		{ path: 'f.ts', old: 'a', new: 'b' },
		{ path: 'f.ts', old: 'c', new: 'd' },
	]
	expect(input('EDIT\nf.ts replace\n!!OLD\na\n!!NEW\nb\n!!OLD\nc\n!!NEW\nd\n!!END').edits).toEqual(pairs)
	expect(input('EDIT\nf.ts replace\n!!OLD\na\n!!NEW\nb\n!!END\n!!OLD\nc\n!!NEW\nd\n!!END').edits).toEqual(pairs)
	expect(input('EDIT\nf.ts create then !!NEW\nz\n!!END')).toEqual({
		edits: [{ path: 'f.ts', create: true, new: 'z\n' }],
	})
	expect(input('EDIT\nf.ts create\nthen !!NEW\nz\n!!END')).toEqual({
		edits: [{ path: 'f.ts', create: true, new: 'z\n' }],
	})
	expect(() => resolve([...head, 'some prose here'].join('\n'))).toThrow('EDIT line 8')
	// An unfinished second operation is not dropped.
	expect(() => resolve([...head, 'delete placeholder'].join('\n'))).toThrow()
	expect(readFileSync(diag.file(), 'utf8')).toContain('quirk fired for openai/gpt-6.1-sol in s1: EDIT: "$ command"')
})

test('rest of line: bare words fill the main text field; quoted or ambiguous calls stay strict', () => {
	expect(input('bash ls -l')).toEqual({ command: 'ls -l' })
	expect(input('bash echo "a b" | wc // count')).toEqual({ command: 'echo "a b" | wc // count' })
	expect(input('BASH sleep 5 { background: true }')).toEqual({ command: 'sleep 5', background: true })
	expect(input('BASH /* List */ ls -la')).toMatchObject({ command: 'ls -la' })
	expect(input('send 12-abc hello there')).toEqual({ to: '12-abc', text: 'hello there' })
	expect(input('SEND "12-abc" hello there')).toEqual({ to: '12-abc', text: 'hello there' })
	expect(input('bash ls')).toEqual({ command: 'ls' })
	fails('BASH ls -l { timeot: 5 }')
	fails('BASH "cat a" "b"')
	fails('bash ls -l\nmore')
	expect(input('READ a.ts b.ts')).toEqual({ paths: [{ path: 'a.ts' }, { path: 'b.ts' }] })
})

test('a lone !!NEW outside EDIT opens the block; !!OLD stays an error', () => {
	expect(input('BASH\n!!NEW\necho "hi"\n!!END')).toEqual({ command: 'echo "hi"' })
	fails('BASH\n!!OLD\nx\n!!END')
})

test('READ_BLOB is READ_ENTRY', () => {
	expect(resolve('READ_BLOB "t35"').name).toBe('read_entry')
})

test('calls joined with "; " split after a closed argument only', () => {
	let split = (cmd: string) =>
		nativeTool.expand({ type: 'tool_call', id: 'c', name: 'tool', input: { cmd } }, ctx()).map((c) => [c.name, c.input])
	expect(split('READ "a.ts"; BASH "ls; pwd"')).toEqual([
		['read', { path: 'a.ts' }],
		['bash', { command: 'ls; pwd' }],
	])
	expect(split('GREP "x" ; READ "b.ts"')).toEqual([
		['grep', { pattern: 'x' }],
		['read', { path: 'b.ts' }],
	])
	expect(split('BASH "echo a; READ b"')).toEqual([['bash', { command: 'echo a; READ b' }]])
})
