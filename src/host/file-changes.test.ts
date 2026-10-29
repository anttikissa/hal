import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { replay } from '../common/replay.ts'
import { transcript } from '../common/transcript.ts'
import { commits } from './commits.ts'
import { fileChanges } from './file-changes.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { sessions } from './sessions.ts'
import { tools } from './tools.ts'
import type { ToolContext } from './tools.ts'
import { paths } from './paths.ts'
import { pluginFiles } from './plugin-files.ts'
import { plugins } from './plugins.ts'

let home = '',
	cwd = '',
	id = ''
const savedHome = paths.state.home
beforeEach(async () => {
	commits.state.seen = []
	home = mkdtempSync(`${process.cwd()}/.hal-file-changes-`)
	paths.state.home = home
	cwd = `${home}/repo`
	mkdirSync(cwd)
	id = sessions.create({ cwd, model: 'fake/m' }).id
	await fileChanges.git(cwd, ['init', '-q'])
})
afterEach(() => {
	host.reset()
	sessions.closeAll()
	if (savedHome === undefined) paths.state.home = undefined
	else paths.state.home = savedHome
	rmSync(home, { recursive: true, force: true })
})
const context = (sessionId = id): ToolContext => ({
	sessionId,
	cwd,
	signal: new AbortController().signal,
	callId: 'c1',
})
const bash = (command: string, modifies?: unknown, ctx = context()) =>
	tools.run(
		{
			type: 'tool_call',
			id: ctx.callId!,
			name: 'bash',
			input: { command, description: 'Change test files', ...(modifies === undefined ? {} : { modifies }) },
		},
		ctx,
	)
const changes = () => history.readSync(id).filter((r) => r.type === 'file_changes')
const bytes = (hash: unknown) => readFileSync(fileChanges.blobPath(id, hash as string))

test('Bash observers run after recording and unlocking; failure reports without undoing the write', async () => {
	const owner = { path: `${home}/observer.ts`, hash: '', hooks: [], open: true as const }
	plugins.api(owner).around(pluginFiles, 'changed', async (next, files, ctx) => {
		await next(files, ctx)
		expect(ctx.sessionId).toBe(id)
		expect(files.map((f) => f.path)).toEqual(['created'])
		expect(changes()).toHaveLength(1)
		expect(fileChanges.state.locks).toHaveLength(0)
		throw new Error('linter failed after write')
	})
	try {
		const result = await bash('printf saved > created', ['created'])
		expect(result.isError).toBe(true)
		expect(result.output).toContain('linter failed after write')
		expect(readFileSync(`${cwd}/created`, 'utf8')).toBe('saved')
	} finally {
		plugins.deactivate(owner)
	}
})

// One integration test covers all snapshot transitions; undeclared files are never recorded.
test('snapshots creations, edits, deletes and new glob matches; records declared paths only', async () => {
	writeFileSync(`${cwd}/edit`, 'old')
	writeFileSync(`${cwd}/gone`, 'delete me')
	writeFileSync(`${cwd}/same`, 'untouched')
	await fileChanges.git(cwd, ['add', '.'])
	let result = await bash('printf new > edit; rm gone; touch same; printf created > new.txt; printf other > other', [
		'edit',
		'gone',
		'same',
		'*.txt',
	])
	expect(result.isError).toBeUndefined()
	let r = changes()[0]!
	expect(r).toMatchObject({ toolId: 'c1', cwd })
	expect(r.files.map((f) => f.path).sort()).toEqual(['edit', 'gone', 'new.txt'])
	let edit = r.files.find((f) => f.path === 'edit')!
	expect(bytes(edit.before).toString()).toBe('old')
	expect(bytes(edit.after).toString()).toBe('new')
	let gone = r.files.find((f) => f.path === 'gone')!
	expect(bytes(gone.before).toString()).toBe('delete me')
	expect(gone.after).toBeNull()
	let fresh = r.files.find((f) => f.path === 'new.txt')!
	expect(fresh.before).toBeNull()
	expect(bytes(fresh.after).toString()).toBe('created')
	expect(replay.toMessages([r])).toEqual([])
	expect(transcript.recordItems(r, 0)).toEqual([])
	await bash('printf different > edit; printf new > surprise')
	expect(changes()).toHaveLength(1)
})

// Bug 2026-10-06: a commit by another session during a call was recorded
// as this session's change and announced as its edit (task c4x).
test('another session changing and committing an undeclared file during a call is in no changes and no edit note', async () => {
	let other = sessions.create({ cwd, model: 'fake/m' }).id
	writeFileSync(`${cwd}/scroll.ts`, 'old')
	await fileChanges.git(cwd, ['add', '.'])
	await fileChanges.git(cwd, [
		'-c',
		'user.name=Example',
		'-c',
		'user.email=example@example.org',
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-qm',
		'Initial',
	])
	// Dirty before the call, clean after: what Git status saw in the bug.
	writeFileSync(`${cwd}/scroll.ts`, 'dirty')
	let running = bash('sleep 0.3; printf mine > mine', ['mine'])
	await Bun.sleep(100)
	let theirs = await bash(
		'printf new > scroll.ts && git add scroll.ts && git -c user.name=Example -c user.email=example@example.org -c commit.gpgsign=false commit -qm Scroll',
		undefined,
		{ ...context(other), callId: 'c2' },
	)
	let mine = await running
	let all = [id, other].flatMap((s) =>
		history
			.readSync(s)
			.filter((r) => r.type === 'file_changes')
			.flatMap((r) => r.files.map((f) => f.path)),
	)
	expect(all).toEqual(['mine'])
	for (let output of [
		theirs.output,
		mine.output,
		(await bash('true', undefined, { ...context(other), callId: 'c3' })).output,
	])
		expect(output).not.toContain('scroll.ts')
})

test('sensitive paths and symlink aliases, and large files retain metadata not bytes', async () => {
	writeFileSync(`${cwd}/.env`, 'private')
	symlinkSync('.env', `${cwd}/alias`)
	writeFileSync(`${cwd}/large`, Buffer.alloc(fileChanges.maxBytes + 1))
	mkdirSync(`${cwd}/secrets`)
	writeFileSync(`${cwd}/secrets/token.txt`, 'private')
	writeFileSync(`${cwd}/wallet.dat`, 'private')
	await bash(
		'printf changed-secret > .env; printf changed-secret > secrets/token.txt; printf changed-secret > wallet.dat; printf x >> large',
		['.env', 'alias', 'large', 'secrets/token.txt', 'wallet.dat'],
	)
	let files = changes()[0]!.files
	expect(files).toHaveLength(5)
	for (let f of files) {
		expect(typeof f.before).toBe('object')
		expect(typeof f.after).toBe('object')
		expect(f.after).toHaveProperty('size')
	}
	expect(readFileSync(history.file(id), 'utf8')).not.toContain('private')
	expect(() => bytes('..')).toThrow('invalid snapshot hash')
})

test('background calls hold overlapping locks until exit and record final bytes', async () => {
	history.append(id, { type: 'assistant', block: { type: 'tool_call', name: 'bash', id: 'bg', input: {} } })
	let result = await tools.run(
		{
			type: 'tool_call',
			id: 'bg',
			name: 'bash',
			input: {
				command: 'sleep 0.3; printf background > file',
				description: 'Create later',
				background: true,
				modifies: ['file'],
			},
		},
		context(),
	)
	expect(result.output).toContain('started in background')
	// Its own session waits too, and the wait names the job, not the session.
	let seen = ''
	await bash('printf foreground >> file', [`${cwd}/file`], {
		...context(),
		onOutput: (c) => {
			seen += c
		},
	})
	expect(seen).toMatch(/^Waiting for background job t\d+ \(this session\) to exit; it declared file\n/)
	expect(readFileSync(`${cwd}/file`, 'utf8')).toBe('backgroundforeground')
	expect(bytes(changes()[0]!.files[0]!.after).toString()).toBe('background')
})

test('invalid declarations never execute; failed commands still retain changes', async () => {
	for (let modifies of ['file', [null], [''], ['bad\0path']]) {
		expect((await bash('touch ran', modifies)).isError).toBe(true)
	}
	expect(changes()).toHaveLength(0)
	let result = await bash('printf changed > file; exit 4', ['file'])
	expect(result.output).toContain('[exit 4]')
	expect(bytes(changes()[0]!.files[0]!.after).toString()).toBe('changed')
})

test('absolute scratch declarations are tracked; outside and Git paths are accepted but ignored', async () => {
	let scratch = mkdtempSync('/tmp/hal-tracked-')
	try {
		let literal = `${scratch}/scratch.log`,
			pattern = `${scratch}/*.txt`
		let result = await bash(`printf log > '${literal}'; printf glob > '${scratch}/new.txt'`, [literal, pattern])
		expect(result.isError).toBeUndefined()
		let files = changes()[0]!.files
		expect(files.map((f) => f.path).sort()).toEqual([`${scratch}/new.txt`, literal].sort())
		for (let f of files) {
			expect(f.before).toBeNull()
			expect(bytes(f.after).toString()).toBe(f.path === literal ? 'log' : 'glob')
		}
		let release = await fileChanges.acquire(context(), ['.git/private', '../outside.txt'])
		try {
			let ignored = await bash(
				'printf git > .git/private; printf outside > ../outside.txt',
				['.git/private', '../outside.txt', `${home}/outside.txt`],
				{
					...context(),
					onOutput: () => {
						throw new Error('excluded declarations waited for a lock')
					},
				},
			)
			expect(ignored.isError).toBeUndefined()
			expect(changes()).toHaveLength(1)
		} finally {
			release()
		}
		symlinkSync('../outside.txt', `${cwd}/alias`)
		symlinkSync('.git/private', `${cwd}/git-alias`)
		writeFileSync(`${cwd}/keep.txt`, 'old')
		symlinkSync('keep.txt', `${cwd}/moved-alias`)
		let broad = await bash(
			'printf tracked > keep.txt; printf outside-new > alias; printf git-new > git-alias; ln -sf ../outside.txt moved-alias',
			['**/*'],
		)
		expect(broad.isError).toBeUndefined()
		expect(changes()[1]!.files.map((f) => f.path)).toEqual(['keep.txt'])
		expect(readFileSync(`${home}/outside.txt`, 'utf8')).toBe('outside-new')
		expect(readFileSync(`${cwd}/.git/private`, 'utf8')).toBe('git-new')
	} finally {
		rmSync(scratch, { recursive: true, force: true })
	}
})

test('generated trees and ignored files are not captured; tracked ignored files and new source files are', async () => {
	mkdirSync(`${cwd}/node_modules/pkg`, { recursive: true })
	mkdirSync(`${cwd}/runs`, { recursive: true })
	writeFileSync(`${cwd}/node_modules/pkg/index.js`, 'dependency')
	writeFileSync(`${cwd}/runs/tracked.txt`, 'source')
	await fileChanges.git(cwd, ['add', 'runs/tracked.txt'])
	writeFileSync(`${cwd}/.gitignore`, 'runs/\nignored.txt\n')
	writeFileSync(`${cwd}/runs/output.txt`, 'generated')
	writeFileSync(`${cwd}/ignored.txt`, 'ignored')
	symlinkSync('runs/output.txt', `${cwd}/alias`)
	symlinkSync('node_modules/pkg/index.js', `${cwd}/dependency-alias`)
	let result = await bash(
		'printf new > node_modules/pkg/index.js; printf new > runs/output.txt; printf new > ignored.txt; printf new > runs/tracked.txt; printf source > new.ts',
		['**/*'],
	)
	expect(result.isError).toBeUndefined()
	expect(
		changes()[0]!
			.files.map((f) => f.path)
			.sort(),
	).toEqual(['new.ts', 'runs/tracked.txt'])
	expect(bytes(changes()[0]!.files.find((f) => f.path === 'runs/tracked.txt')!.before).toString()).toBe('source')
	let previous = changes().length
	await bash('printf again > ignored.txt; printf again > node_modules/pkg/index.js', [
		'ignored.txt',
		'node_modules/pkg/index.js',
	])
	expect(changes()).toHaveLength(previous)
	let write = await tools.run(
		{
			type: 'tool_call',
			id: 'write-ignored',
			name: 'edit',
			input: { edits: [{ path: 'ignored.txt', new: 'written' }] },
		},
		context(),
	)
	expect(write.isError).toBeUndefined()
	expect(readFileSync(`${cwd}/ignored.txt`, 'utf8')).toBe('written')
	expect(changes()).toHaveLength(previous)
})

test('non-Git glob expansion prunes dependency trees and still tracks ordinary scratch files', async () => {
	let scratch = mkdtempSync('/tmp/hal-tracking-glob-')
	try {
		mkdirSync(`${scratch}/node_modules/pkg`, { recursive: true })
		mkdirSync(`${scratch}/src`)
		writeFileSync(`${scratch}/node_modules/pkg/x.ts`, 'dependency')
		writeFileSync(`${scratch}/src/x.ts`, 'source')
		expect(await fileChanges.expand(scratch, ['**/*.ts'])).toEqual(['src/x.ts'])
	} finally {
		rmSync(scratch, { recursive: true, force: true })
	}
})

// Task hy: a commit a bash call makes is announced once, except to
// clients watching the session its Session trailer names (task pdw:
// without one, no session); moving HEAD back is no commit; an amend
// says 'amended'.
test('a commit in a bash call notifies other tabs once; a reset does not; an amend says amended', async () => {
	let other = sessions.create({ cwd, model: 'fake/m' }).id
	let elsewhere: any[] = [],
		watching: any[] = []
	let fakes = [
		{ visible: other, deliver: (e: any) => elsewhere.push(e) },
		{ visible: id, deliver: (e: any) => watching.push(e) },
	] as any[]
	for (let c of fakes) host.state.clients.add(c)
	try {
		let git = 'git -c user.name=t -c user.email=t@example.com'
		await bash(`printf z > z && ${git} add z && ${git} commit -qm untrailed`)
		expect(elsewhere.splice(0)).toMatchObject([{ session: id, line: expect.stringMatching(/ untrailed$/) }])
		expect(watching.splice(0)).toHaveLength(0)
		await bash(`printf a > a && ${git} add a && ${git} commit -qm 'first line' -m 'body' -m 'Session: ${id}'`)
		let hash = (await fileChanges.git(cwd, ['rev-parse', 'HEAD'])).text.trim()
		expect(elsewhere).toMatchObject([
			{ type: 'notice', session: id, kind: 'commit', key: `commit:${hash}`, line: `${hash.slice(0, 7)} first line` },
		])
		await bash(
			`printf b > b && ${git} add b && ${git} commit -qm second -m 'Session: ${id}' && ${git} reset -q --hard HEAD~1`,
		)
		expect(elsewhere.map((e) => e.line.split(' ')[1])).toEqual(['first', 'second'])
		await bash(`${git} reset -q --hard HEAD`)
		expect(elsewhere).toHaveLength(2)
		await bash(`${git} commit -q --amend -m reworded -m 'Session: ${id}'`)
		expect(elsewhere[2]).toMatchObject({ what: 'amended', line: expect.stringMatching(/ reworded$/) })
		expect(elsewhere[0].what).toBeUndefined()
		expect(watching).toEqual([])
	} finally {
		for (let c of fakes) host.state.clients.delete(c)
	}
})

// Task sg0: plugins hook commits.committed; its lines follow the output
// of the call whose own-session commit it describes, and only that one.
// Task 179: the commit rides on that result, shown as card n.1.
test('commit hook lines follow the result of the call that made the commit', async () => {
	let seen: any[] = []
	let original = commits.committed
	commits.committed = async (info) => {
		seen.push(info)
		return [`hooked ${info.short}`]
	}
	try {
		let git = 'git -c user.name=t -c user.email=t@example.com'
		let plain = await bash(`printf z > z && ${git} add z && ${git} commit -qm untrailed`)
		expect(plain.output).toContain('hooked')
		expect(plain.commits).toMatchObject([{ subject: 'untrailed' }])
		expect(seen.splice(0)).toMatchObject([{ sessionId: id, subject: 'untrailed' }])
		let made = await bash(`printf 'a\\nb\\n' > a && ${git} add a && ${git} commit -qm first -m 'Session: ${id}'`)
		let short = (await fileChanges.git(cwd, ['rev-parse', '--short', 'HEAD'])).text.trim()
		expect(made.output).toEndWith(`\n\nhooked ${short}`)
		expect(seen).toMatchObject([
			{ sessionId: id, subject: 'first', files: [{ path: expect.stringMatching(/\/repo\/a$/), added: 2, removed: 0 }] },
		])
		expect(made.commits).toEqual([
			{
				hash: expect.any(String),
				short,
				subject: 'first',
				files: [{ path: 'a', added: 2, removed: 0 }],
				lines: [`hooked ${short}`],
			},
		])
		let items = transcript.recordItems({ type: 'user', n: 7, ts: '', blocks: [made] }, 0)
		expect(items.map((i) => [i.type, i.key])).toEqual([
			['tool-result', '7'],
			['output', '7.1'],
		])
		expect(items[1]).toMatchObject({ text: `${short} first\n+2 -0 a\nhooked ${short}` })
	} finally {
		commits.committed = original
	}
})

// Task jfy: a trailerless commit another session's call made while this
// call ran stays with the call whose output printed its hash.
test('a concurrent trailerless commit goes to the call that printed its hash', async () => {
	let other = sessions.create({ cwd, model: 'fake/m' }).id
	let git = 'git -c user.name=t -c user.email=t@example.com'
	let wait = (f: string) => `until [ -f ${f} ]; do sleep 0.01; done`
	let mine = bash(`printf m > m && ${git} add m && ${git} commit -m mine && touch go && ${wait('theirs')}`)
	let theirs = bash(
		`${wait('go')}; printf t > t && ${git} add t && ${git} commit -m theirs && touch theirs && ${wait('end')}`,
		undefined,
		context(other),
	)
	expect((await mine).commits).toMatchObject([{ subject: 'mine' }])
	writeFileSync(`${cwd}/end`, '')
	expect((await theirs).commits).toMatchObject([{ subject: 'theirs' }])
})
