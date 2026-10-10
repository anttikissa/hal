import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
import { promptCache } from './prompt-cache.ts'
import { systemPrompt } from './system-prompt.ts'
import { slash } from './slash.ts'
import { liveFiles } from './live-file.ts'

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
	expect(applied.n).toBe(6)
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

test('dropping a model state transition independently restores the starting model', () => {
	seed()
	history.append(id, { type: 'command', text: '/model fake/b' })
	history.append(id, { type: 'change', model: 'fake/b', previous: { model: 'fake/m' } })
	sessions.open(id).model = 'fake/b'
	rebases.apply(id, { base: 6, drop: [6], edit: [] })
	expect(sessions.open(id).model).toBe('fake/m')
})

test('rebase restores cwd, qualified model and autoclose without replaying commands; undo restores edited settings', async () => {
	seed()
	history.append(id, { type: 'notice', text: 'Old project instructions', sectionUpdate: true })
	let transition = history.append(id, { type: 'change', cwd: '/new', model: 'openai/gpt-6-sol:max', autoclose: true, previous: { cwd: '/', model: 'fake/m', autoclose: false } })
	let note = history.append(id, { type: 'notice', text: 'New project instructions', sectionUpdate: true })
	Object.assign(sessions.open(id), { cwd: '/new', model: 'openai/gpt-6-sol', effort: 'max', autoclose: true })
	await history.messages(id)
	let base = history.readSync(id).at(-1)!.n!
	let bytes = readFileSync(history.file(id))
	rebases.apply(id, { base, drop: [transition.n!, note.n!], edit: [] })
	expect(sessions.open(id)).toMatchObject({ cwd: '/', model: 'fake/m', autoclose: false })
	expect(sessions.open(id).effort).toBeUndefined()
	expect(readFileSync(history.file(id)).subarray(0, bytes.length)).toEqual(bytes)
	let text = JSON.stringify(await history.messages(id))
	expect(text).toContain('Old project instructions')
	expect(text).not.toContain('New project instructions')
	expect(history.readSync(id).filter((r) => r.type === 'change')).toHaveLength(1)
	rebases.apply(id, { base, drop: [], edit: [] }, history.readSync(id).at(-1)!.n)
	expect(sessions.open(id)).toMatchObject({ cwd: '/new', model: 'openai/gpt-6-sol', effort: 'max', autoclose: true })
})

test('dropping a cwd transition and its update restores historical project instructions even after disk edits', async () => {
	let a = `${home}/a`, b = `${home}/b`, file = `${home}/SYSTEM.md`
	mkdirSync(a); mkdirSync(b)
	writeFileSync(`${a}/AGENTS.md`, 'Original project A rules')
	writeFileSync(`${b}/AGENTS.md`, 'Project B rules')
	writeFileSync(file, 'Static instructions\n:: section "Cwd" update="diff"\n$cwd\n::\n:: section "Local instructions" update="diff"\n$agents\n::')
	let original = systemPrompt.file
	systemPrompt.file = () => file
	try {
		id = sessions.create({ cwd: a, model: 'fake/m' }).id
		seed()
		let frozen = promptCache.prepare(id, { cwd: a, model: 'fake/m', now: 1000 }).system
		expect(frozen).toContain('Original project A rules')
		slash.change(id, { cwd: b })
		promptCache.prepare(id, { cwd: b, model: 'fake/m', now: 2000 })
		await history.messages(id)
		let raw = history.readSync(id)
		let transition = raw.findLast((r) => r.type === 'change')!, note = raw.findLast((r) => r.type === 'notice' && r.sectionUpdate)!
		expect(note.type === 'notice' && note.text).toContain('Project B rules')
		writeFileSync(`${a}/AGENTS.md`, 'A disk change after the transition')
		rebases.apply(id, { base: raw.at(-1)!.n!, drop: [transition.n!, note.n!], edit: [] })
		expect(sessions.open(id).cwd).toBe(a)
		expect(promptCache.prepare(id, { cwd: a, model: 'fake/m', now: 3000 }).system).toBe(frozen)
		let input = frozen + JSON.stringify(await history.messages(id))
		expect(input).toContain('Original project A rules')
		expect(input).not.toContain('Project B rules')
		expect(input).not.toContain('A disk change after the transition')
		expect(history.readSync(id).filter((r) => r.type === 'notice' && r.sectionUpdate)).toHaveLength(1)
		writeFileSync(`${a}/AGENTS.md`, 'Genuine later source edit')
		promptCache.prepare(id, { cwd: a, model: 'fake/m', now: 4000 })
		expect(JSON.stringify(await history.messages(id))).toContain('Genuine later source edit')
	} finally { systemPrompt.file = original }
})

test('invalid setting edits fail before pausing or writing; a note-only edit leaves host settings intact', async () => {
	seed()
	let change = history.append(id, { type: 'change', cwd: '/new', previous: { cwd: '/' } })
	let note = history.append(id, { type: 'notice', text: 'Original rules', sectionUpdate: true })
	sessions.open(id).cwd = '/new'
	let base = note.n!, bytes = readFileSync(history.file(id))
	expect(() => rebases.apply(id, { base, drop: [], edit: [{ n: change.n!, text: '{cwd: 42}' }] })).toThrow('invalid session setting')
	expect(readFileSync(history.file(id))).toEqual(bytes)
	rebases.apply(id, { base, drop: [], edit: [{ n: note.n!, text: 'User injected instructions' }] })
	expect(sessions.open(id).cwd).toBe('/new')
	expect(JSON.stringify(await history.messages(id))).toContain('User injected instructions')
})

test('committed settings recover after metadata synchronization fails without replaying commands', () => {
	seed()
	let transition = history.append(id, { type: 'change', cwd: '/new', previous: { cwd: '/' } })
	sessions.open(id).cwd = '/new'
	liveFiles.save(sessions.open(id))
	let save = liveFiles.save
	liveFiles.save = () => { throw new Error('metadata disk full at session.ason') }
	try {
		expect(() => rebases.apply(id, { base: transition.n!, drop: [transition.n!], edit: [] })).toThrow(/Rebase applied as #\d+; settings synchronization failed[\s\S]*metadata disk full at session.ason/)
	} finally { liveFiles.save = save }
	expect(history.readSync(id).at(-1)).toMatchObject({ type: 'rebase', contextChanged: true })
	Object.assign(sessions.open(id), { cwd: '/new' })
	liveFiles.save(sessions.open(id))
	sessions.close(id)
	expect(sessions.open(id).cwd).toBe('/')
	expect(history.readSync(id).filter((r) => r.type === 'change')).toHaveLength(1)
})

test('missing starting state refuses setting surgery without migration but permits notice edits', () => {
	seed()
	delete sessions.open(id).startingState
	let transition = history.append(id, { type: 'change', cwd: '/new', previous: { cwd: '/' } })
	let note = history.append(id, { type: 'notice', text: 'Original note' })
	expect(() => rebases.apply(id, { base: note.n!, drop: [transition.n!], edit: [] })).toThrow('no starting state')
	expect(history.readSync(id).at(-1)?.n).toBe(note.n)
	rebases.apply(id, { base: note.n!, drop: [], edit: [{ n: note.n!, text: 'Edited note' }] })
	expect(sessions.open(id).startingState).toBeUndefined()
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

test('failed rewrite commit keeps original content even when it must pause before committing', async () => {
	seed()
	let append = history.append
	history.append = (id, record) => {
		if (record.type === 'rebase') throw new Error('disk full at history path')
		return append(id, record)
	}
	try {
		expect(() => rebases.apply(id, { base: 4, drop: [2], edit: [] })).toThrow('Rebase was not applied; the session is paused.\ndisk full at history path')
		expect(history.readSync(id).some((r) => r.type === 'rebase')).toBe(false)
		expect(snapshots.build(id).state.type).toBe('paused')
		expect(JSON.stringify(await history.messages(id))).toContain('oldanswer')
	} finally { history.append = append }
})
