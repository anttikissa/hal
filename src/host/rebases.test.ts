import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { history } from './history.ts'
import { host } from './host.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { rebases } from './rebases.ts'
import { snapshots } from './snapshots.ts'
import { status } from './status.ts'
import { findIndex } from './find-index.ts'
import { context } from './context.ts'
import { tool as readBlob } from './tools/read_blob.ts'

let savedHome = process.env.HAL_HOME, home = '', id = ''
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-rebase-`)
	process.env.HAL_HOME = home
	paths.init()
	id = sessions.create({ cwd: '/', model: 'fake/m' }).id
})
afterEach(() => {
	findIndex.state.db?.close(); findIndex.state.db = undefined
	host.reset(); sessions.closeAll()
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})
function seed() {
	history.submit(id, 'oldneedle')
	history.append(id, { type: 'assistant', block: { type: 'text', text: 'oldanswer' } })
	history.append(id, { type: 'round', usage: { cacheRead: 3000 } })
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
}

test('apply is append-only; provider input, pages, index and links project edits and drops; undo restores', async () => {
	seed()
	let prefix = readFileSync(history.file(id))
	findIndex.init(); await findIndex.catchup(id)
	let applied = rebases.apply(id, { base: 4, drop: [2], edit: [{ n: 1, text: 'newneedle' }] })
	expect(applied.n).toBe(5)
	expect(snapshots.build(id).dropped).toEqual([2])
	expect(readFileSync(history.file(id)).subarray(0, prefix.length)).toEqual(prefix)
	expect(JSON.stringify(await history.messages(id))).toContain('newneedle')
	expect(JSON.stringify(await history.messages(id))).not.toContain('oldanswer')
	expect(pages.page(id, undefined, 1).records.map((r) => r.n)).toEqual(expect.arrayContaining([1, 3, 4]))
	expect(snapshots.build(id).state.type).toBe('paused')
	expect(pages.snapshot(id, 1).history[0]).toMatchObject({ blocks: [{ text: 'newneedle' }] })
	expect(await readBlob.run({ id: '#2' }, { sessionId: id } as any)).toContain('dropped')
	await findIndex.catchup(id)
	let texts = findIndex.state.db!.query('SELECT text FROM docs WHERE sessionId=?').all(id)
	expect(JSON.stringify(texts)).toContain('newneedle')
	expect(JSON.stringify(texts)).not.toContain('oldneedle')
	expect(JSON.stringify(texts)).not.toContain('oldanswer')
	rebases.apply(id, { base: 4, drop: [], edit: [] }, history.readSync(id).at(-1)!.n)
	expect(JSON.stringify(await history.messages(id))).toContain('oldanswer')
	expect(snapshots.build(id).dropped).toEqual([])
	expect(pages.page(id, undefined, 1).records.map((r) => r.n)).toEqual(expect.arrayContaining([1, 2, 3, 4]))
})

test('stale, running and question-bound plans are refused without appending', () => {
	seed()
	let plan = { base: 4, drop: [2], edit: [] }
	expect(() => rebases.apply(id, { ...plan, base: 3 })).toThrow('stale')
	status.state.states.set(id, { type: 'running', phase: 'tools' })
	expect(() => rebases.apply(id, plan)).toThrow('Pause')
	status.state.states.set(id, { type: 'idle' })
	history.append(id, { type: 'question', id: 'q', form: { text: 'Question', fields: [] }, from: { command: 'example', args: '' } })
	expect(() => rebases.apply(id, { ...plan, base: 5 })).toThrow('question')
	expect(history.readSync(id).at(-1)?.type).toBe('question')
})

test('a rebase marks the next graph point even when context grows', () => {
	seed()
	rebases.apply(id, { base: 4, drop: [2], edit: [] })
	history.append(id, { type: 'round', usage: { input: 4000 } })
	expect(context.points(history.readSync(id)).at(-1)?.cause).toBe('rebase')
})

test('dropped signed blocks are never expanded', async () => {
	history.submit(id, 'go')
	history.append(id, { type: 'assistant', block: { type: 'thinking', text: 'reason', signatureBlob: 'abcdef123456', provider: 'anthropic' } })
	history.append(id, { type: 'assistant', block: { type: 'text', text: 'answer' } })
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	rebases.apply(id, { base: 4, drop: [2], edit: [] })
	expect(JSON.stringify(await history.messages(id))).not.toContain('reason')
})


test('edited tool output survives an omission saved before the rebase', async () => {
 history.submit(id, 'go')
 history.append(id, {type:'assistant',block:{type:'tool_call',id:'call',name:'bash',input:{}}})
 history.append(id, {type:'user',blocks:[{type:'tool_result',id:'call',output:'long original '.repeat(1000)}]})
 history.append(id, {type:'turn_end',status:'completed',usage:{}})
 writeFileSync(`${paths.sessionDir(id)}/projection.ason`, '{boundary:0, checkpoint:0, pressure:-1, omitted:[3], consumed:[2,3]}')
 expect(JSON.stringify(await history.messages(id))).toContain('[pruned')
 rebases.apply(id, {base:4, drop:[], edit:[{n:3,text:'retained edit'}]})
 expect(JSON.stringify(await history.messages(id))).toContain('retained edit')
 expect(JSON.stringify(await history.messages(id))).not.toContain('[pruned tool output')
})
