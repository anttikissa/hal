import '../src/host/host.ts'
import { expect, test, spyOn } from 'bun:test'
import { readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, unlinkSync } from 'fs'
import { multiedit, io, parseBlocks } from './multiedit.ts'
import { fileChanges } from '../src/host/file-changes.ts'
import { lease } from '../src/host/lease.ts'
import { client, created, testHome, useHost } from '../src/host/host-fixture.test.ts'
import { paths } from '../src/host/paths.ts'

useHost()

test('symlink retargeting cannot overwrite another file with identical bytes', async () => {
 const a = file('a', 'same'), b = file('b', 'same'), original = io.save
 const mock = spyOn(io, 'save').mockImplementation(async (...args) => { unlinkSync(a); symlinkSync(b, a); await original(...args) })
 try {
  await expect(run([{ path: 'a', old: 'same', new: 'changed' }])).rejects.toThrow('target identity changed')
  expect(readFileSync(b, 'utf8')).toBe('same')
 } finally { mock.mockRestore() }
})

test('cancellation after a write rolls the entire change back', async () => {
 const a = file('a', 'old'), b = file('b', 'before'), controller = new AbortController(), original = io.save
 let calls = 0
 const mock = spyOn(io, 'save').mockImplementation(async (...args) => { await original(...args); if (++calls === 1) controller.abort() })
 try {
  await expect(run([{ path: 'a', old: 'old', new: 'new' }, { path: 'b', old: 'before', new: 'after' }], controller.signal)).rejects.toThrow('Rolled back all writes')
  expect(readFileSync(a, 'utf8')).toBe('old')
  expect(readFileSync(b, 'utf8')).toBe('before')
 } finally { mock.mockRestore() }
})

test('cleanup failure preserves the original failure', async () => {
 file('a', 'same')
 const original = fileChanges.finish
 const mock = spyOn(fileChanges, 'finish').mockImplementation(async (...args) => { await original(...args); throw new Error('finish failure') })
 try {
  const result = run([{ path: 'a', old: 'missing', new: 'x' }])
  await expect(result).rejects.toThrow('old not found')
  await expect(result).rejects.toThrow('finish failure')
 } finally { mock.mockRestore() }
})
const nl = String.fromCharCode(10), crlf = String.fromCharCode(13, 10)
const run = (edits: unknown[], signal = new AbortController().signal) => multiedit.run({ edits }, { cwd: testHome(), sessionId: created(client(), testHome()), signal, callId: 'edit' })
const file = (name: string, text: string) => { writeFileSync(`${testHome()}/${name}`, text); return `${testHome()}/${name}` }

test('text steps, version-checked ranges and creation commit together with verified feedback', async () => {
 const a = file('a', 'old'), b = file('b', ['a', 'b', 'c'].join(crlf))
 const out = await run([{ path: 'a', old: 'old', new: 'new' }, { path: 'a', old: 'new', new: 'done' }, { path: 'b', hash: lease.hash(readFileSync(b)), range: 2, lines: ['B'] }, { path: 'b', hash: lease.hash(readFileSync(b)), range: 3, lines: [] }, { path: 'deep/new', new: 'created' }])
 expect(readFileSync(a, 'utf8')).toBe('done')
 expect(readFileSync(b, 'utf8')).toBe(['a', 'B'].join(crlf))
 expect(readFileSync(`${testHome()}/deep/new`, 'utf8')).toBe('created')
 expect(out).toContain(`@${lease.hash(readFileSync(a))} verified`)
 expect(out).toContain('+1 done')
})

test('failures validate before writes, including duplicate aliases and stale ranges', async () => {
 const a = file('a', 'one' + nl + 'two' + nl), b = file('b', 'same same')
 symlinkSync('a', `${testHome()}/alias`)
 await expect(run([{ path: 'a', hash: lease.hash(readFileSync(a)), range: 1, lines: ['A'] }, { path: 'alias', hash: lease.hash(readFileSync(a)), range: 1, lines: ['X'] }, { path: 'b', old: 'same', new: 'other' }, { path: 'new', new: 'new' }])).rejects.toThrow('step 2 (alias):')
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
 await run(parseBlocks(['', 'a insert-before 2', '!!NEW', 'x', '!!END', 'a insert-after 1', '!!NEW', 'y', '!!END', 'a replace 2-2', '!!NEW', 'two', '!!END'].join(nl)).edits)
 expect(readFileSync(a, 'utf8')).toBe(['1', 'x', 'y', 'two', '3'].join(nl) + nl)
})

test('an action after the last block runs once the edit is written; a failed edit runs none', async () => {
 const a = file('a', 'old' + nl)
 const { edits, then } = parseBlocks(['', 'a replace', '!!OLD', 'old', '!!NEW', 'new', '!!END', 'BASH "cat a"'].join(nl))
 expect(then).toEqual(['BASH "cat a"'])
 const out = await multiedit.run({ edits, then }, { cwd: testHome(), sessionId: created(client(), testHome()), signal: new AbortController().signal, callId: 'edit' })
 expect(out).toMatch(/== then BASH "cat a" ==\n\[exit 0\]\nnew/)
 await expect(multiedit.run({ edits: [{ path: 'a', old: 'missing', new: 'x' }], then: ['BASH "touch ran"'] }, { cwd: testHome(), sessionId: created(client(), testHome()), signal: new AbortController().signal, callId: 'edit' })).rejects.toThrow('Nothing written')
 expect(existsSync(`${testHome()}/ran`)).toBe(false)
})

test('a file takes line operations and text replaces together; text applies after lines', async () => {
 const a = file('a', ['1', '2', '3', 'tail'].join(nl) + nl)
 await run(parseBlocks(['', 'a replace', '!!OLD', 'tail', '!!NEW', 'TAIL', '!!END', 'a replace 2-2', '!!NEW', 'two', '!!END'].join(nl)).edits)
 expect(readFileSync(a, 'utf8')).toBe(['1', 'two', '3', 'TAIL'].join(nl) + nl)
})

test('the parser is strict: stray text after the last block is an error naming its line', () => {
 const head = ['', 'a replace', '!!OLD', 'x', '!!NEW', 'y', '!!END']
 for (const tail of [['<invoke name="Action">'], ['$ npm test'], ['approve', 'BASH "npm test"'], ['!!END'], ['some prose here']]) expect(() => parseBlocks([...head, ...tail].join(nl))).toThrow('EDIT line 8')
 expect(() => parseBlocks([...head, 'f.ts replace', '!!OLD', '!!NEW', '!!END'].join(nl))).toThrow('needs nonempty old text')
 expect(parseBlocks([...head, 'BASH "ls"'].join(nl)).then).toEqual(['BASH "ls"'])
})

for (const external of [false, true]) test(`write failure rolls back; external conflict=${external}`, async () => {
 const a = file('a', 'old'), b = file('b', 'before'), original = io.save
 let calls = 0
 const mock = spyOn(io, 'save').mockImplementation(async (...args) => { if (++calls === 3) { if (external) writeFileSync(a, 'external'); throw new Error('injected failure') }; await original(...args) })
 try {
  await expect(run([{ path: 'new', new: 'created' }, { path: 'a', old: 'old', new: 'changed' }, { path: 'b', old: 'before', new: 'after' }])).rejects.toThrow(external ? 'Recovery copies:' : 'Rolled back all writes')
  expect(readFileSync(a, 'utf8')).toBe(external ? 'external' : 'old')
  expect(readFileSync(b, 'utf8')).toBe('before')
  expect(existsSync(`${testHome()}/new`)).toBe(false)
  if (external) {
   const dir = readdirSync(paths.tmpDir()).find((p) => p.startsWith('multiedit-'))!
   expect(readFileSync(`${paths.tmpDir()}/${dir}/1`, 'utf8')).toBe('old')
  }
 } finally { mock.mockRestore() }
})

test('ambiguous text reports planned context without writing and supports a contextual retry', async () => {
 const before = ['first', 'target', '', 'spacer', '', 'second', 'target', '', 'spacer', '', 'third', 'target'].join(nl)
 const a = file('a', before), b = file('b', 'original')
 const edits = [{ path: 'b', old: 'original', new: 'changed' }, { path: 'a', old: 'first', new: 'planned first' }, { path: 'a', old: 'target', new: 'replacement' }]
 const message = await run(edits).then(() => { throw new Error('expected rejection') }, (e: Error) => e.message)
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
 await run([...edits.slice(0, 2), { path: 'a', old: 'planned first' + nl + 'target', new: 'planned first' + nl + 'replacement' }])
 expect(readFileSync(a, 'utf8')).toBe(before.replace('first', 'planned first').replace('target', 'replacement'))
 expect(readFileSync(b, 'utf8')).toBe('changed')
})

test('ambiguity context is bounded even when matching lines are long', async () => {
 const before = Array.from({ length: 200 }, () => 'target' + 'x'.repeat(5000)).join(nl)
 const a = file('a', before)
 const message = await run([{ path: 'a', old: 'target', new: 'other' }]).then(() => { throw new Error('expected rejection') }, (e: Error) => e.message)
 expect(message).toContain('old matched 200 times')
 expect(message).toContain('[line cut]')
 expect(message.length).toBeLessThan(4000)
 expect(readFileSync(a, 'utf8')).toBe(before)
})

test('explicit counts replace exactly the nonoverlapping literal matches in planned text', async () => {
 const a = file('a', 'same same'), b = file('b', 'aaaaa $&'), hash = lease.hash(readFileSync(a))
 await run([{ path: 'a', old: 'same', new: 'same!', count: 2, hash }, { path: 'a', old: 'same!', new: '$&', count: 2 }, { path: 'b', old: 'aa', new: 'x', count: 2 }])
 expect(readFileSync(a, 'utf8')).toBe('$& $&')
 expect(readFileSync(b, 'utf8')).toBe('xxa $&')
 await run([{ path: 'b', old: 'xx', new: 'done', count: 1 }])
 expect(readFileSync(b, 'utf8')).toBe('donea $&')
})

test('wrong counts and the default uniqueness guard reject the whole batch', async () => {
 const a = file('a', 'same same'), b = file('b', 'original')
 for (const selector of [{ count: 1 }, { count: 3 }, {}, { old: 'missing', count: 2 }]) {
  await expect(run([{ path: 'b', old: 'original', new: 'changed' }, { path: 'a', old: 'same', new: 'replacement', ...selector }, { path: 'new', new: 'created' }])).rejects.toThrow('Nothing written: step 2 (a):')
  expect(readFileSync(a, 'utf8')).toBe('same same')
  expect(readFileSync(b, 'utf8')).toBe('original')
  expect(existsSync(`${testHome()}/new`)).toBe(false)
 }
})

test('counts reject invalid values and non-text selectors without writing', async () => {
 const a = file('a', 'same'), hash = lease.hash(readFileSync(a))
 const selectors = [
  ...[0, -1, 1.5, '1', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true].map((count) => ({ old: 'same', new: 'changed', count })),
  { hash, range: 1, lines: ['changed'], count: 1 }, { hash, new: 'changed', count: 1 },
  { old: 'same', new: 'changed', range: 1, count: 1 }, { old: 'same', new: 'changed', lines: [], count: 1 },
 ]
 for (const selector of selectors) {
  await expect(run([{ path: 'new', new: 'created' }, { path: 'a', ...selector }])).rejects.toThrow('count requires exact text and a positive safe integer')
  expect(readFileSync(a, 'utf8')).toBe('same')
  expect(existsSync(`${testHome()}/new`)).toBe(false)
 }
})

test('all existing range forms remain accepted; a whole-file write combines with nothing', async () => {
 for (const range of [2, '2', '2-2', '2,2', [2], [2, 2]]) {
  const a = file('a', ['first', 'second', 'third'].join(nl)), hash = lease.hash(readFileSync(a))
  await run([{ path: 'a', hash, range, lines: ['changed'] }])
  expect(readFileSync(a, 'utf8')).toBe(['first', 'changed', 'third'].join(nl))
 }
 const a = file('a', 'original'), hash = lease.hash(readFileSync(a))
 await expect(run([{ path: 'a', hash, new: 'planned' }, { path: 'a', hash, range: 1, lines: ['other'] }])).rejects.toThrow('step 1 (a): a whole-file write cannot be combined')
 expect(readFileSync(a, 'utf8')).toBe('original')
})
