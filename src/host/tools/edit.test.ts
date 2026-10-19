import '../host.ts'
import { expect, test } from 'bun:test'
import { readFileSync, existsSync, symlinkSync, unlinkSync } from 'fs'
import { tool as multiedit } from './edit.ts'
import { crlf, file, nl, run } from './edit-fixture.test.ts'
import { editBlocks } from '../edit-blocks.ts'
import { fileText } from '../file-text.ts'
import { client, created, testHome, useHost } from '../host-fixture.test.ts'
import { toolPresentations } from '../tool-presentation.ts'
import { toolPresentation } from '../../common/tool-presentation.ts'
import { tools } from '../tools.ts'

useHost()

test('text steps, version-checked ranges and creation return contents or a single diff', async () => {
	const a = file('a', 'old'),
		b = file('b', ['a', 'b', 'c'].join(crlf))
	const edits = [
		{ path: 'a', old: 'old', new: 'new' },
		{ path: 'a', old: 'new', new: 'done' },
		{ path: 'b', hash: fileText.hash(readFileSync(b)), range: 2, lines: ['B'] },
		{ path: 'b', hash: fileText.hash(readFileSync(b)), range: 3, lines: [] },
		{ path: 'deep/new', new: 'created' },
	]
	const out = await run(edits)
	expect(readFileSync(a, 'utf8')).toBe('done')
	expect(readFileSync(b, 'utf8')).toBe(['a', 'B'].join(crlf))
	expect(readFileSync(`${testHome()}/deep/new`, 'utf8')).toBe('created')
	expect(out).toContain(`== a@${fileText.hash(readFileSync(a))} ==\n-1: old\n+1: done`)
	expect(out).not.toContain(testHome())
	expect(out).toContain(`== deep/new@${fileText.hash(Buffer.from('created'))} ==\n1: created`)
	const card = toolPresentations.present(
		{ type: 'tool_call', id: 'edit', name: 'edit', input: { edits } },
		{ type: 'tool_result', id: 'edit', output: out },
	)!
	toolPresentation.check(card, out)
	expect(card.blocks).toHaveLength(1)
	expect(toolPresentation.text(card.blocks[0]!, out)).toBe(out)
})

test('whole-file writes return READ output; uppercase operations return only a contextual diff', async () => {
	const a = file('a', 'before'),
		id = created(client(), testHome())
	const output = await run(editBlocks.parse('a WRITE\n!!NEW\none\ntwo\nthree\n!!END').edits)
	const read = await tools.run(
		{ type: 'tool_call', id: 'read', name: 'read', input: { path: 'a', offset: 1 } },
		{ cwd: testHome(), sessionId: id, signal: new AbortController().signal },
	)
	expect(output).toBe(read.output)
	const changed = await run(editBlocks.parse('a REPLACE\n!!OLD\ntwo\n!!NEW\nkaksi\n2\n!!END').edits)
	expect(changed).toBe(`== a@${fileText.hash(readFileSync(a))} ==\n 1: one\n-2: two\n+2: kaksi\n+3: 2\n 4: three`)
	for (const operation of ['CREATE', 'DELETE', 'INSERT-BEFORE 1', 'INSERT-AFTER 1']) {
		const block = operation === 'DELETE' ? '' : '\n!!NEW\nx\n!!END'
		expect(editBlocks.parse(`b ${operation}${block}`).edits).toHaveLength(1)
	}
})

test('failures validate before writes, including duplicate aliases and stale ranges', async () => {
	const a = file('a', 'one' + nl + 'two' + nl),
		b = file('b', 'same same')
	symlinkSync('a', `${testHome()}/alias`)
	await expect(
		run([
			{ path: 'a', hash: fileText.hash(readFileSync(a)), range: 1, lines: ['A'] },
			{ path: 'alias', hash: fileText.hash(readFileSync(a)), range: 1, lines: ['X'] },
			{ path: 'b', old: 'same', new: 'other' },
			{ path: 'new', new: 'new' },
		]),
	).rejects.toThrow('step 2 (alias):')
	expect(readFileSync(a, 'utf8')).toBe('one' + nl + 'two' + nl)
	expect(readFileSync(b, 'utf8')).toBe('same same')
	expect(existsSync(`${testHome()}/new`)).toBe(false)
	await expect(run([{ path: 'a', hash: 'stale', range: 1, lines: [] }])).rejects.toThrow('stale version')
	// A version is advisory: checked when given, but its absence is the caller's risk.
	await run([{ path: 'a', new: 'overwrite' }])
	expect(readFileSync(a, 'utf8')).toBe('overwrite')
})

test('inserts at one point and a range starting there apply in written order', async () => {
	const a = file('a', ['1', '2', '3'].join(nl) + nl)
	await run(
		editBlocks.parse(
			[
				'',
				'a insert-before 2',
				'!!NEW',
				'x',
				'!!END',
				'a insert-after 1',
				'!!NEW',
				'y',
				'!!END',
				'a replace 2-2',
				'!!NEW',
				'two',
				'!!END',
			].join(nl),
		).edits,
	)
	expect(readFileSync(a, 'utf8')).toBe(['1', 'x', 'y', 'two', '3'].join(nl) + nl)
})

test('removing whole lines by text, even with !!OLD alone, leaves no blank line; a fragment keeps its line', async () => {
	const a = file('a', ['1', '2', '3', 'x y'].join(nl) + nl)
	await run(
		editBlocks.parse(['', 'a replace', '!!OLD', '2', '!!END', 'a replace', '!!OLD', ' y', '!!NEW', '!!END'].join(nl))
			.edits,
	)
	expect(readFileSync(a, 'utf8')).toBe(['1', '3', 'x'].join(nl) + nl)
})

test('a call after the last block runs once the edit is written; a failed edit runs none', async () => {
	file('a', 'old' + nl)
	const { edits, then } = editBlocks.parse(
		['', 'a replace', '!!OLD', 'old', '!!NEW', 'new', '!!END', 'BASH "cat a"'].join(nl),
	)
	expect(then).toEqual(['BASH "cat a"'])
	const out = await multiedit.run(
		{ edits, then },
		{ cwd: testHome(), sessionId: created(client(), testHome()), signal: new AbortController().signal, callId: 'edit' },
	)
	expect(out).toMatch(/== then BASH "cat a" ==\n\[exit 0\]\nnew/)
	await expect(
		multiedit.run(
			{ edits: [{ path: 'a', old: 'missing', new: 'x' }], then: ['BASH "touch ran"'] },
			{
				cwd: testHome(),
				sessionId: created(client(), testHome()),
				signal: new AbortController().signal,
				callId: 'edit',
			},
		),
	).rejects.toThrow('Nothing written')
	expect(existsSync(`${testHome()}/ran`)).toBe(false)
})

test('a file takes line operations and text replaces together; text applies after lines', async () => {
	const a = file('a', ['1', '2', '3', 'tail'].join(nl) + nl)
	await run(
		editBlocks.parse(
			['', 'a replace', '!!OLD', 'tail', '!!NEW', 'TAIL', '!!END', 'a replace 2-2', '!!NEW', 'two', '!!END'].join(nl),
		).edits,
	)
	expect(readFileSync(a, 'utf8')).toBe(['1', 'two', '3', 'TAIL'].join(nl) + nl)
})

test('deletes accept one optional END before another operation or trailing call', async () => {
	for (const ending of [nl, crlf]) {
		const a = file('a', ['keep', 'remove'].join(ending) + ending)
		const b = file('b', 'gone')
		const { edits, then } = editBlocks.parse(
			[
				`a@${fileText.hash(readFileSync(a))} delete 2-2`,
				'!!END',
				`b@${fileText.hash(readFileSync(b))} delete`,
				'!!END',
				'c create',
				'!!NEW',
				'new',
				'!!END',
				'a delete 1-1',
				'!!END',
				'READ c',
			].join(ending),
		)
		expect(then).toEqual(['READ c'])
		await run(edits)
		expect(readFileSync(a, 'utf8')).toBe('')
		expect(existsSync(b)).toBe(false)
		expect(readFileSync(`${testHome()}/c`, 'utf8')).toBe('new' + nl)
		unlinkSync(`${testHome()}/c`)
	}
	for (const operation of ['delete', 'delete 147-147']) {
		const header = `src/web/components/Card.tsx@1e49h ${operation}`
		expect(editBlocks.parse(header + nl + '!!END').edits).toEqual(editBlocks.parse(header).edits)
		expect(() => editBlocks.parse(header + nl + '!!END' + nl + '!!END')).toThrow('EDIT line 3')
		expect(() => editBlocks.parse(header + nl + '!!NEW')).toThrow('EDIT line 2')
	}
})

test('the parser is strict: stray text after the last block is an error naming its line', () => {
	const head = ['', 'a replace', '!!OLD', 'x', '!!NEW', 'y', '!!END']
	for (const tail of [
		['<invoke name="tool">'],
		['$ npm test'],
		['approve', 'BASH "npm test"'],
		['!!END'],
		['some prose here'],
	])
		expect(() => editBlocks.parse([...head, ...tail].join(nl))).toThrow('EDIT line 8')
	expect(() => editBlocks.parse([...head, 'f.ts replace', '!!OLD', '!!NEW', '!!END'].join(nl))).toThrow(
		'needs nonempty old text',
	)
	expect(editBlocks.parse([...head, 'BASH "ls"'].join(nl)).then).toEqual(['BASH "ls"'])
})

test('ambiguous text reports planned context without writing and supports a contextual retry', async () => {
	const before = ['first', 'target', '', 'spacer', '', 'second', 'target', '', 'spacer', '', 'third', 'target'].join(nl)
	const a = file('a', before),
		b = file('b', 'original')
	const edits = [
		{ path: 'b', old: 'original', new: 'changed' },
		{ path: 'a', old: 'first', new: 'planned first' },
		{ path: 'a', old: 'target', new: 'replacement' },
	]
	const message = await run(edits).then(
		() => {
			throw new Error('expected rejection')
		},
		(e: Error) => e.message,
	)
	expect(message).toContain('Nothing written: step 3 (a): old matched 3 times')
	expect(message).toContain('planned text after earlier steps (not a READ version)')
	expect(message).toContain('1: planned first')
	expect(message).toContain('2: target')
	expect(message).toContain('6: second')
	expect(message).toContain('7: target')
	expect(message).not.toContain('third')
	expect(message).not.toContain('== READ')
	expect(readFileSync(a, 'utf8')).toBe(before)
	expect(readFileSync(b, 'utf8')).toBe('original')
	await run([
		...edits.slice(0, 2),
		{ path: 'a', old: 'planned first' + nl + 'target', new: 'planned first' + nl + 'replacement' },
	])
	expect(readFileSync(a, 'utf8')).toBe(before.replace('first', 'planned first').replace('target', 'replacement'))
	expect(readFileSync(b, 'utf8')).toBe('changed')
})

test('ambiguity context is bounded even when matching lines are long', async () => {
	const before = Array.from({ length: 200 }, () => 'target' + 'x'.repeat(5000)).join(nl)
	const a = file('a', before)
	const message = await run([{ path: 'a', old: 'target', new: 'other' }]).then(
		() => {
			throw new Error('expected rejection')
		},
		(e: Error) => e.message,
	)
	expect(message).toContain('old matched 200 times')
	expect(message).toContain('[line cut]')
	expect(message.length).toBeLessThan(4000)
	expect(readFileSync(a, 'utf8')).toBe(before)
})

test('explicit counts replace exactly the nonoverlapping literal matches in planned text', async () => {
	const a = file('a', 'same same'),
		b = file('b', 'aaaaa $&'),
		hash = fileText.hash(readFileSync(a))
	await run([
		{ path: 'a', old: 'same', new: 'same!', count: 2, hash },
		{ path: 'a', old: 'same!', new: '$&', count: 2 },
		{ path: 'b', old: 'aa', new: 'x', count: 2 },
	])
	expect(readFileSync(a, 'utf8')).toBe('$& $&')
	expect(readFileSync(b, 'utf8')).toBe('xxa $&')
	await run([{ path: 'b', old: 'xx', new: 'done', count: 1 }])
	expect(readFileSync(b, 'utf8')).toBe('donea $&')
})

test('wrong counts and the default uniqueness guard reject the whole batch', async () => {
	const a = file('a', 'same same'),
		b = file('b', 'original')
	for (const selector of [{ count: 1 }, { count: 3 }, {}, { old: 'missing', count: 2 }]) {
		await expect(
			run([
				{ path: 'b', old: 'original', new: 'changed' },
				{ path: 'a', old: 'same', new: 'replacement', ...selector },
				{ path: 'new', new: 'created' },
			]),
		).rejects.toThrow('Nothing written: step 2 (a):')
		expect(readFileSync(a, 'utf8')).toBe('same same')
		expect(readFileSync(b, 'utf8')).toBe('original')
		expect(existsSync(`${testHome()}/new`)).toBe(false)
	}
})

test('counts reject invalid values and non-text selectors without writing', async () => {
	const a = file('a', 'same'),
		hash = fileText.hash(readFileSync(a))
	const selectors = [
		...[0, -1, 1.5, '1', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true].map((count) => ({
			old: 'same',
			new: 'changed',
			count,
		})),
		{ hash, range: 1, lines: ['changed'], count: 1 },
		{ hash, new: 'changed', count: 1 },
		{ old: 'same', new: 'changed', range: 1, count: 1 },
		{ old: 'same', new: 'changed', lines: [], count: 1 },
	]
	for (const selector of selectors) {
		await expect(
			run([
				{ path: 'new', new: 'created' },
				{ path: 'a', ...selector },
			]),
		).rejects.toThrow('count requires exact text and a positive safe integer')
		expect(readFileSync(a, 'utf8')).toBe('same')
		expect(existsSync(`${testHome()}/new`)).toBe(false)
	}
})

test('colon ranges beside the path or operation keep versions and range validation', () => {
	for (const op of ['replace', 'DELETE', 'insert-before', 'INSERT-AFTER']) {
		const block = op.toLowerCase() === 'delete' ? '' : '\n!!NEW\ntesting\n!!END'
		const range = op.toLowerCase().startsWith('insert-') ? '5' : '5-6'
		for (const path of ['foo.txt', 'foo.txt@abcde']) {
			const expected = editBlocks.parse(`${path} ${op} ${range}${block}`)
			expect(editBlocks.parse(`${path}:${range} ${op}${block}`)).toEqual(expected)
			expect(editBlocks.parse(`${path} ${op}:${range}${block}`)).toEqual(expected)
		}
	}
})

test('all existing range forms remain accepted; a whole-file write combines with nothing', async () => {
	for (const range of [2, '2', '2-2', '2,2', [2], [2, 2]]) {
		const a = file('a', ['first', 'second', 'third'].join(nl)),
			hash = fileText.hash(readFileSync(a))
		await run([{ path: 'a', hash, range, lines: ['changed'] }])
		expect(readFileSync(a, 'utf8')).toBe(['first', 'changed', 'third'].join(nl))
	}
	const a = file('a', 'original'),
		hash = fileText.hash(readFileSync(a))
	await expect(
		run([
			{ path: 'a', hash, new: 'planned' },
			{ path: 'a', hash, range: 1, lines: ['other'] },
		]),
	).rejects.toThrow('step 1 (a): a whole-file write cannot be combined')
	expect(readFileSync(a, 'utf8')).toBe('original')
})

test('file deletion accepts advisory versions, commits with edits and deletes empty files', async () => {
	const a = file('a', 'remove\n'),
		empty = file('empty', ''),
		b = file('b', 'old')
	const parsed = editBlocks.parse(`a@${fileText.hash(readFileSync(a))} delete\nempty delete`)
	const out = await run([...parsed.edits, { path: 'b', old: 'old', new: 'new' }])
	expect(existsSync(a)).toBe(false)
	expect(existsSync(empty)).toBe(false)
	expect(readFileSync(b, 'utf8')).toBe('new')
	expect(out).toContain('== a deleted ==')
	expect(out).toContain('-1: remove')
})

test('invalid or mixed file deletions reject the whole batch', async () => {
	const a = file('a', 'original'),
		hash = fileText.hash(readFileSync(a))
	for (const edits of [
		[{ path: 'a', hash: 'stale', delete: true }],
		[{ path: 'a', hash: '', delete: true }],
		[{ path: 'missing', delete: true }],
		[{ path: 'a', hash, delete: false }],
		[{ path: 'a', hash, delete: true, new: '' }],
		[
			{ path: 'a', hash, delete: true },
			{ path: 'a', hash, new: '' },
		],
		[
			{ path: 'a', hash, range: 1, lines: [] },
			{ path: 'a', hash, delete: true },
		],
	]) {
		await expect(run([{ path: 'new', new: 'created' }, ...edits])).rejects.toThrow('Nothing written')
		expect(readFileSync(a, 'utf8')).toBe('original')
		expect(existsSync(`${testHome()}/new`)).toBe(false)
	}
})
