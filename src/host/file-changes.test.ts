import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { replay } from '../common/replay.ts'
import { transcript } from '../common/transcript.ts'
import { fileChanges } from './file-changes.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { sessions } from './sessions.ts'
import { tools } from './tools.ts'
import { tabs } from './tabs.ts'
import type { ToolContext } from './tools.ts'

let home = '', cwd = '', id = ''
const savedHome = process.env.HAL_HOME
beforeEach(async () => {
	home = mkdtempSync('/tmp/hal-file-changes-')
	process.env.HAL_HOME = home
	cwd = `${home}/repo`
	mkdirSync(cwd)
	id = sessions.create({ cwd, model: 'fake/m' }).id
	await fileChanges.git(cwd, ['init', '-q'])
})
afterEach(() => {
	host.reset()
	sessions.closeAll()
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})
const context = (sessionId = id): ToolContext => ({ sessionId, cwd, signal: new AbortController().signal, callId: 'c1' })
const bash = (command: string, modifies?: unknown, ctx = context()) => tools.run({ type: 'tool_call', id: ctx.callId!, name: 'bash', input: { command, description: 'Change test files', ...(modifies === undefined ? {} : { modifies }) } }, ctx)
const changes = () => history.readSync(id).filter((r) => r.type === 'file_changes')
const bytes = (hash: unknown) => readFileSync(fileChanges.blobPath(id, hash as string))

// One integration test covers all snapshot transitions and the Git observation
// boundary, including a dirty file whose status stays unchanged.
test('snapshots creations, edits, deletes and new glob matches; observes undeclared status only', async () => {
	writeFileSync(`${cwd}/edit`, 'old')
	writeFileSync(`${cwd}/gone`, 'delete me')
	writeFileSync(`${cwd}/same`, 'untouched')
	await fileChanges.git(cwd, ['add', '.'])
	let result = await bash('printf new > edit; rm gone; touch same; printf created > new.txt; printf other > other', ['edit', 'gone', 'same', '*.txt'])
	expect(result.isError).toBeUndefined()
	let r = changes()[0]!
	expect(r).toMatchObject({ toolId: 'c1', cwd })
	expect(r.files.map((f) => f.path).sort()).toEqual(['edit', 'gone', 'new.txt', 'other'])
	let edit = r.files.find((f) => f.path === 'edit')!
	expect(bytes(edit.before).toString()).toBe('old')
	expect(bytes(edit.after).toString()).toBe('new')
	let gone = r.files.find((f) => f.path === 'gone')!
	expect(bytes(gone.before).toString()).toBe('delete me')
	expect(gone.after).toBeNull()
	let fresh = r.files.find((f) => f.path === 'new.txt')!
	expect(fresh.before).toBeNull()
	expect(bytes(fresh.after).toString()).toBe('created')
	expect(r.files.find((f) => f.path === 'other')).toEqual({ path: 'other', undeclared: true, statusBefore: null, statusAfter: '??' })
	expect(replay.toMessages([r])).toEqual([])
	expect(transcript.recordItems(r, 0)).toEqual([])
	await bash('printf different > edit; printf new > surprise')
	expect(changes()[1]!.files.map((f) => f.path)).toEqual(['surprise'])
})

test('sensitive paths and symlink aliases, and large files retain metadata not bytes', async () => {
	writeFileSync(`${cwd}/.env`, 'private')
	symlinkSync('.env', `${cwd}/alias`)
	writeFileSync(`${cwd}/large`, Buffer.alloc(fileChanges.maxBytes + 1))
	await bash('printf changed-secret > .env; printf x >> large', ['.env', 'alias', 'large'])
	let files = changes()[0]!.files
	expect(files).toHaveLength(3)
	for (let f of files) {
		expect(typeof f.before).toBe('object')
		expect(typeof f.after).toBe('object')
		expect(f.after).toHaveProperty('size')
	}
	expect(readFileSync(history.file(id), 'utf8')).not.toContain('private')
	expect(() => bytes('..')).toThrow('invalid snapshot hash')
})

test('overlapping aliases wait across sessions; disjoint and undeclared calls do not; waiting cancels', async () => {
	writeFileSync(`${cwd}/file`, 'old')
	symlinkSync('file', `${cwd}/alias`)
	tabs.file().open = [...Array.from({ length: 7 }, (_, i) => `other-${i}`), id]
	let owner = await fileChanges.begin(context(), ['file'])
	let second = sessions.create({ cwd, model: 'fake/m' }).id
	let chunks: string[] = []
	let waiting = false
	let next = fileChanges.begin({ ...context(second), onOutput: (c) => { chunks.push(c); waiting = true } }, [`${cwd}/alias`])
	for (let i = 0; i < 100 && !waiting; i++) await Bun.sleep(5)
	expect(chunks.join('')).toBe(`Waiting for tab 8 (${id}) to finish editing file\n`)
	let disjoint = await fileChanges.begin(context(second), ['other'])
	disjoint.release()
	let undeclared = await fileChanges.begin(context(second), [])
	undeclared.release()
	let controller = new AbortController()
	let cancelled = fileChanges.begin({ ...context(second), signal: controller.signal }, ['file'])
	controller.abort()
	await expect(cancelled).rejects.toThrow('cancelled')
	writeFileSync(`${cwd}/file`, 'first')
	await fileChanges.finish(owner)
	let acquired = await next
	expect(bytes(acquired.before.get(`${cwd}/alias`)).toString()).toBe('first')
	acquired.release()
	expect(fileChanges.state.locks).toHaveLength(0)
})

test('background calls hold overlapping locks until exit and record final bytes', async () => {
	history.append(id, { type: 'assistant', block: { type: 'tool_call', name: 'bash', id: 'bg', input: {} } })
	let result = await tools.run({ type: 'tool_call', id: 'bg', name: 'bash', input: { command: 'sleep 0.3; printf background > file', description: 'Create later', background: true, modifies: ['file'] } }, context())
	expect(result.output).toContain('started in background')
	// Its own session waits too, and the wait names the job, not the session.
	let seen = ''
	await bash('printf foreground >> file', ['file'], { ...context(), onOutput: (c) => { seen += c } })
	expect(seen).toMatch(/^Waiting for background job #t\d+ \(this session\) to exit; it declared file\n/)
	expect(readFileSync(`${cwd}/file`, 'utf8')).toBe('backgroundforeground')
	expect(bytes(changes()[0]!.files[0]!.after).toString()).toBe('background')
})

test('invalid declarations never execute; failed commands still retain changes', async () => {
	for (let modifies of ['file', [null], ['/outside/file'], ['../file']]) {
		expect((await bash('touch ran', modifies)).isError).toBe(true)
	}
	expect(changes()).toHaveLength(0)
	let result = await bash('printf changed > file; exit 4', ['file'])
	expect(result.output).toContain('[exit 4]')
	expect(bytes(changes()[0]!.files[0]!.after).toString()).toBe('changed')
})

test('absolute scratch literals and globs snapshot files outside cwd', async () => {
	let literal = `${cwd}/scratch.log`, pattern = `${home}/*.txt`
	let result = await bash(`printf log > '${literal}'; printf glob > '${home}/new.txt'`, [literal, pattern])
	expect(result.isError).toBeUndefined()
	let files = changes()[0]!.files
	expect(files.map((f) => f.path).sort()).toEqual([`${home}/new.txt`, literal].sort())
	for (let f of files) {
		expect(f.before).toBeNull()
		expect(bytes(f.after).toString()).toBe(f.path === literal ? 'log' : 'glob')
	}
	let bad = await bash('touch ran', ['/tmp/../outside'])
	expect(bad.output).toContain('modifies[0]')
	expect(bad.output).toContain('parent traversal')
	expect(bad.output).toContain('command did not run')
})

// Task hy: a commit a bash call makes is announced once, to the committing
// session, except to clients watching it; moving HEAD back is no commit;
// an amend says 'amended'.
test('a commit in a bash call notifies other tabs once; a reset does not; an amend says amended', async () => {
	let other = sessions.create({ cwd, model: 'fake/m' }).id
	let elsewhere: any[] = [], watching: any[] = []
	let fakes = [{ visible: other, deliver: (e: any) => elsewhere.push(e) }, { visible: id, deliver: (e: any) => watching.push(e) }] as any[]
	for (let c of fakes) host.state.clients.add(c)
	try {
		let git = 'git -c user.name=t -c user.email=t@example.com'
		await bash(`printf a > a && ${git} add a && ${git} commit -qm 'first line' -m 'body'`)
		let hash = (await fileChanges.git(cwd, ['rev-parse', 'HEAD'])).text.trim()
		expect(elsewhere).toMatchObject([{ type: 'notice', session: id, kind: 'commit', key: `commit:${hash}`, line: `${hash.slice(0, 7)} first line` }])
		await bash(`printf b > b && ${git} add b && ${git} commit -qm second && ${git} reset -q --hard HEAD~1`)
		expect(elsewhere.map((e) => e.line.split(' ')[1])).toEqual(['first', 'second'])
		await bash(`${git} reset -q --hard HEAD`)
		expect(elsewhere).toHaveLength(2)
		await bash(`${git} commit -q --amend -m reworded`)
		expect(elsewhere[2]).toMatchObject({ what: 'amended', line: expect.stringMatching(/ reworded$/) })
		expect(elsewhere[0].what).toBeUndefined()
		expect(watching).toEqual([])
	} finally { for (let c of fakes) host.state.clients.delete(c) }
})
