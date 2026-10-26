// Plugin sync (task zh7) between two homes in one process: each side's
// plugin history and loaded-plugin table are swapped in around every
// call, and the client's commands reach the host handler directly.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { type Event } from '../common/protocol.ts'
import { pluginHistory } from './plugin-history.ts'
import { pluginSync } from './plugin-sync.ts'
import { pluginSyncClient, StaleError } from './plugin-sync-client.ts'
import { plugins, type Loaded } from './plugins.ts'
import { paths } from './paths.ts'
import { commandCheck } from '../common/command-check.ts'
import { ason } from '../common/ason.ts'
import { pluginSyncWire } from '../common/plugin-sync.ts'

type Side = { home: string; dir: string; hist: typeof pluginHistory.state; files: Map<string, Loaded> }

const saved = {
	hist: pluginHistory.state,
	files: plugins.state.files,
	home: paths.state.home,
	send: pluginSyncClient.send,
	report: plugins.report,
}
let root = '',
	client: Side,
	server: Side
let sent: any[] = []
// Drops the host's answers while true, as a lost connection would.
let lose = false

function makeSide(name: string, home = join(root, name)): Side {
	let dir = join(home, 'plugins')
	let personal = join(home, '.agents/plugins/hal')
	mkdirSync(dir, { recursive: true })
	mkdirSync(personal, { recursive: true })
	let s: Side = {
		home,
		dir,
		hist: {
			dir: undefined,
			personal: undefined,
			home: new Map(),
			watchers: [],
			error: undefined,
			versions: new Map(),
			heads: new Map(),
		},
		files: new Map(),
	}
	use(s)
	pluginHistory.init(
		dir,
		personal,
		Object.fromEntries(pluginSyncWire.HOME_FILES.map((file) => [file, join(home, file)])),
	)
	return s
}

function use(s: Side): void {
	pluginHistory.state = s.hist
	plugins.state.files = s.files
	paths.state.home = s.home
}

function on<T>(s: Side, fn: () => T): T {
	use(s)
	try {
		return fn()
	} finally {
		use(client)
	}
}

// Writes (undefined: deletes) a portable plugin on side `s`.
function put(s: Side, file: string, text: string | undefined, portable = true): void {
	on(s, () => {
		let path = pluginHistory.filePath(file)
		if (text === undefined) {
			if (existsSync(path)) unlinkSync(path)
		} else writeFileSync(path, text)
		pluginHistory.seen(path)
		if (text !== undefined && portable) s.files.set(path, { path, hash: '', hooks: [], portable: true })
	})
}

const read = (s: Side, file: string) =>
	on(s, () => {
		let path = pluginHistory.filePath(file)
		return existsSync(path) ? readFileSync(path, 'utf8') : undefined
	})
const ledger = (s: Side) => readFileSync(join(s.dir, 'history.asonl'), 'utf8')
const one = (file: string) => pluginSyncClient.state.discrepancies.find((d) => d.file === file)
const expected = (file: string) => ({
	...(one(file)!.client.id ? { client: one(file)!.client.id } : {}),
	...(one(file)!.server.id ? { server: one(file)!.server.id } : {}),
})
const host = { deliver: (_e: Event) => {} }

// The host answers as host.ts would: checked, then a reply and an ack.
function answer(c: any): void {
	let problem = commandCheck.invalid(c)
	let events: Event[]
	if (problem) events = [{ type: 'rejected', command: c.type, reason: problem, id: c.id }]
	else {
		try {
			events = [on(server, () => pluginSync.command(host, c)).reply, { type: 'ack', id: c.id }]
		} catch (e: any) {
			events = [{ type: 'rejected', command: c.type, reason: String(e?.message ?? e), id: c.id }]
		}
	}
	if (lose) return
	queueMicrotask(() => events.forEach((e) => pluginSyncClient.event(e)))
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'hal-plugin-sync-'))
	plugins.report = () => {}
	server = makeSide('server')
	client = makeSide('client')
	sent = []
	lose = false
	pluginSyncClient.start('example.com')
	pluginSyncClient.state.connected = true
	pluginSyncClient.send = (c) => (sent.push(c), answer(c))
})

afterEach(() => {
	clearTimeout(pluginSyncClient.state.timer)
	pluginSyncClient.state = { ...pluginSyncClient.state, active: false }
	pluginSync.onLocal = () => {}
	on(server, () => pluginHistory.close())
	on(client, () => pluginHistory.close())
	rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
	pluginHistory.state = saved.hist
	plugins.state.files = saved.files
	if (saved.home === undefined) paths.state.home = undefined
	else paths.state.home = saved.home
	pluginSyncClient.send = saved.send
	plugins.report = saved.report
})

test('a portable plugin loads from another home after reviewed transfer without rewriting imports', async () => {
	const text = `import { paths } from 'hal/host/paths.ts'
export const portable = true
export default () => { globalThis.portableHome = paths.home() }
`
	put(client, 'portable.ts', text)
	await pluginSyncClient.compare()
	await pluginSyncClient.apply('portable.ts', 'client', expected('portable.ts'))
	expect(read(server, 'portable.ts')).toBe(text)
	const child = Bun.spawnSync(
		[
			'bun',
			'-e',
			`
		const { paths } = await import(${JSON.stringify(join(import.meta.dir, 'paths.ts'))});
		const { plugins } = await import(${JSON.stringify(join(import.meta.dir, 'plugins.ts'))});
		paths.state.home = ${JSON.stringify(server.home)};
		await plugins.load(${JSON.stringify(join(server.dir, 'portable.ts'))});
		if (globalThis.portableHome !== paths.home()) throw new Error('portable import failed');
		plugins.close();
	`,
		],
		{ cwd: server.home, stdout: 'pipe', stderr: 'pipe' },
	)
	if (child.exitCode) throw new Error(child.stderr.toString())
	use(server)
	try {
		await plugins.load(join(server.dir, 'portable.ts'))
		expect((globalThis as any).portableHome).toBe(server.home)
		expect(pluginSync.portable()).toContain('portable.ts')
		expect(plugins.state.files.get(join(server.dir, 'portable.ts'))?.error).toBeUndefined()
	} finally {
		plugins.remove(join(server.dir, 'portable.ts'))
		delete (globalThis as any).portableHome
		use(client)
	}
})

test('USER.md is compared without being a plugin and replaced on review', async () => {
	put(client, 'USER.md', 'client notes', false)
	put(server, 'USER.md', 'server notes', false)
	await pluginSyncClient.compare()
	expect(one('USER.md')?.relation).toBe('unrelated')
	await pluginSyncClient.apply('USER.md', 'client', expected('USER.md'))
	expect(read(server, 'USER.md')).toBe('client notes')
	expect(one('USER.md')).toBeUndefined()
})

test('config sync transfers portable comments in both directions and preserves current local-only edits', async () => {
	let file = 'config.ason'
	put(client, file, '{\n// shared\nmodel: "one",\n// client port\nwebPort: 9002\n}', false)
	put(server, file, '{\n// server port\nwebPort: 9003, model: "two"\n}', false)
	await pluginSyncClient.compare()
	let compared = expected(file)
	let diff = await pluginSyncClient.diff(file)
	expect(diff.diff).toContain('// shared')
	expect(diff.diff).not.toContain('webPort')
	// No watcher notification: the merge must read the current disk contents.
	writeFileSync(join(server.home, file), '{\n// newly edited port\nwebPort: 9004, model: "two"\n}')
	await pluginSyncClient.apply(file, 'client', compared)
	expect(ason.parse(read(server, file)!)).toEqual({ model: 'one', webPort: 9004 })
	expect(read(server, file)).toContain('// newly edited port')
	expect(read(server, file)).toContain('// shared')
	expect(one(file)).toBeUndefined()
	let old = on(server, () => pluginHistory.head(file)!.id)
	put(server, file, read(server, file)!.replace('newly edited port', 'local comment only'), false)
	await pluginSyncClient.compare()
	expect(one(file)).toBeUndefined()
	expect(on(server, () => pluginHistory.head(file)!.id)).toBe(old)
	put(server, file, read(server, file)!.replace('// shared', '// revised shared'), false)
	await pluginSyncClient.compare()
	await pluginSyncClient.apply(file, 'server', expected(file))
	expect(read(client, file)).toContain('// revised shared')
	expect(read(client, file)).toContain('// client port')
	expect(one(file)).toBeUndefined()
	on(server, () => {
		let home = Object.fromEntries(pluginHistory.state.home)
		pluginHistory.close()
		pluginHistory.init(server.dir, undefined, home)
	})
	await pluginSyncClient.compare()
	expect(one(file)).toBeUndefined()
})

test('config deletion keeps the file and local keys; stale or broken config blocks sync', async () => {
	let file = 'config.ason'
	put(client, file, '{ model: "one" }', false)
	await pluginSyncClient.compare()
	let compared = expected(file)
	writeFileSync(join(server.home, file), '{ model: "edited before watcher" }')
	await expect(pluginSyncClient.apply(file, 'client', compared)).rejects.toBeInstanceOf(StaleError)
	expect(ason.parse(read(server, file)!)).toEqual({ model: 'edited before watcher' })
	compared = expected(file)
	writeFileSync(join(server.home, file), '{ broken')
	await expect(pluginSyncClient.apply(file, 'client', compared)).rejects.toThrow()
	expect(read(server, file)).toBe('{ broken')
	put(server, file, '{ webPort: 9003 }', false)
	await pluginSyncClient.compare()
	await pluginSyncClient.apply(file, 'server', expected(file))
	expect(read(client, file)).toBe('{}\n')
	expect(one(file)).toBeUndefined()
	put(client, file, '{ model: "again" }', false)
	await pluginSyncClient.compare()
	await pluginSyncClient.apply(file, 'client', expected(file))
	put(client, file, undefined, false)
	await pluginSyncClient.compare()
	await pluginSyncClient.apply(file, 'client', expected(file))
	expect(ason.parse(read(server, file)!)).toEqual({ webPort: 9003 })
	expect(one(file)).toBeUndefined()
})

test('reviewed personal transfers stay in their namespace and reject nonportable collisions', async () => {
	put(client, 'same.ts', 'home')
	put(client, 'personal/same.ts', 'personal')
	put(server, 'same.ts', 'server home')
	put(server, 'personal/private.ts', 'private', false)
	put(client, 'personal/private.ts', 'portable')
	await pluginSyncClient.compare()
	expect(read(server, 'personal/same.ts')).toBeUndefined()
	expect(one('personal/same.ts')).toBeDefined()
	expect(one('personal/private.ts')).toBeUndefined()
	await pluginSyncClient.apply('personal/same.ts', 'client', expected('personal/same.ts'))
	expect(read(server, 'personal/same.ts')).toBe('personal')
	expect(read(server, 'same.ts')).toBe('server home')
	let privateVersions = on(
		server,
		() =>
			pluginSync.command(host, {
				type: 'sync',
				op: 'history',
				files: ['personal/private.ts'],
			}).reply,
	)
	expect(privateVersions).toMatchObject({ versions: [] })
	await expect(
		pluginSyncClient.apply('personal/private.ts', 'client', {
			client: on(client, () => pluginSync.headOf('personal/private.ts').id),
			server: on(server, () => pluginSync.headOf('personal/private.ts').id),
		}),
	).rejects.toThrow('excluded')
	expect(read(server, 'personal/private.ts')).toBe('private')
	put(server, 'personal/same.ts', read(server, 'personal/same.ts'))
	expect(() =>
		on(server, () => pluginSync.install('personal/same.ts', [], {}, pluginSync.headOf('same.ts').id, 'test', 'server')),
	).toThrow('was not received')
	expect(read(server, 'personal/same.ts')).toBe('personal')
	await pluginSyncClient.ignore('personal/same.ts')
	expect(readFileSync(join(client.dir, '.syncignore'), 'utf8')).toBe('personal/same.ts\n')
})

test('reports each relation, sends only heads for equal files, and suggests the later time', async () => {
	put(server, 'same.ts', 'x')
	put(client, 'same.ts', 'x')
	put(server, 'base.ts', 'v1')
	put(client, 'other.ts', 'mine')
	put(server, 'other.ts', 'theirs')
	await pluginSyncClient.compare()
	expect(sent.map((c) => c.op)).toEqual(['inventory', 'history'])
	expect(sent[1].files).toEqual(['base.ts', 'other.ts'])
	expect(one('same.ts')).toBeUndefined()
	expect(one('base.ts')).toMatchObject({
		relation: 'server-ahead',
		client: { status: 'missing' },
		server: { status: 'present' },
	})
	expect(one('other.ts')!.relation).toBe('unrelated')

	await pluginSyncClient.apply('base.ts', 'server', expected('base.ts'))
	expect(read(client, 'base.ts')).toBe('v1')
	expect(one('base.ts')).toBeUndefined()
	put(client, 'base.ts', 'v2')
	await pluginSyncClient.compare()
	expect(one('base.ts')).toMatchObject({ relation: 'client-ahead', suggest: 'client' })
	put(server, 'base.ts', 'v2 elsewhere')
	await pluginSyncClient.compare()
	expect(one('base.ts')!.relation).toBe('divergent')
	let d = await pluginSyncClient.diff('base.ts')
	expect(d).toMatchObject({ client: 'v2', server: 'v2 elsewhere' })
	expect(d.diff).toContain('+v2')
})

test('missing, empty and deleted stay distinct, and choosing an absent source deletes', async () => {
	put(server, 'gone.ts', 'old')
	await pluginSyncClient.compare()
	await pluginSyncClient.apply('gone.ts', 'server', expected('gone.ts'))
	put(client, 'gone.ts', read(client, 'gone.ts'))
	put(server, 'gone.ts', undefined)
	put(server, 'blank.ts', '')
	await pluginSyncClient.compare()
	expect(one('gone.ts')).toMatchObject({
		relation: 'server-ahead',
		client: { status: 'present' },
		server: { status: 'deleted' },
	})
	expect(one('blank.ts')).toMatchObject({ client: { status: 'missing' }, server: { status: 'empty' } })

	await pluginSyncClient.apply('gone.ts', 'server', expected('gone.ts'))
	expect(read(client, 'gone.ts')).toBeUndefined()
	await pluginSyncClient.apply('blank.ts', 'server', expected('blank.ts'))
	expect(read(client, 'blank.ts')).toBe('')
	expect(pluginSyncClient.state.discrepancies).toEqual([])
	// The replaced client version stays in history.
	expect(on(client, () => pluginSync.versionsOf('gone.ts')).some((v) => v.hash && !v.deleted)).toBe(true)
})

test('using the client version writes the host, keeps both versions, and a resent apply does nothing more', async () => {
	put(client, 'k.ts', 'client keys')
	put(server, 'k.ts', 'server keys')
	await pluginSyncClient.compare()
	let exp = expected('k.ts')
	lose = true
	let pending = pluginSyncClient.apply('k.ts', 'client', exp)
	let apply = sent.at(-1)
	expect(read(server, 'k.ts')).toBe('client keys')
	let before = ledger(server)
	// Reconnecting resends the same command; the host answers it again.
	lose = false
	answer(apply)
	await pending
	expect(ledger(server)).toBe(before)
	expect(read(server, 'k.ts')).toBe('client keys')
	expect(
		on(server, () => pluginSync.versionsOf('k.ts'))
			.map((v) => v.hash)
			.filter(Boolean),
	).toHaveLength(2)
	expect(pluginSyncClient.state.discrepancies).toEqual([])
})

test('a stale choice is refused on either side and the comparison is revised', async () => {
	put(client, 's.ts', 'a')
	put(server, 's.ts', 'b')
	await pluginSyncClient.compare()
	let exp = expected('s.ts')
	put(server, 's.ts', 'c')
	await expect(pluginSyncClient.apply('s.ts', 'client', exp)).rejects.toBeInstanceOf(StaleError)
	expect(read(server, 's.ts')).toBe('c')
	await expect(pluginSyncClient.apply('s.ts', 'server', exp)).rejects.toBeInstanceOf(StaleError)
	expect(read(client, 's.ts')).toBe('a')
	put(client, 's.ts', 'd')
	await expect(pluginSyncClient.apply('s.ts', 'server', expected('s.ts'))).rejects.toBeInstanceOf(StaleError)
	expect(read(client, 's.ts')).toBe('d')
	expect(one('s.ts')!.client.id).toBe(on(client, () => pluginSync.headOf('s.ts').id))
})

test("either side's .syncignore excludes a file; keep separate writes only the client's", async () => {
	put(client, 'mine.ts', '1')
	put(server, 'mine.ts', '2')
	put(client, 'theirs.ts', '1')
	put(server, 'theirs.ts', '2')
	writeFileSync(join(server.dir, '.syncignore'), '# server only\n\ntheirs.ts\n')
	await pluginSyncClient.compare()
	expect(pluginSyncClient.state.discrepancies.map((d) => d.file)).toEqual(['mine.ts'])
	expect(pluginSyncClient.state.excluded).toEqual([{ file: 'theirs.ts', by: 'server' }])
	expect(sent.find((c) => c.op === 'history').files).toEqual(['mine.ts'])
	await expect(
		pluginSyncClient.apply('theirs.ts', 'client', { client: on(client, () => pluginSync.headOf('theirs.ts').id!) }),
	).rejects.toThrow("excluded by the server's plugins/.syncignore")

	await pluginSyncClient.ignore('mine.ts')
	expect(readFileSync(join(client.dir, '.syncignore'), 'utf8')).toBe('mine.ts\n')
	expect(
		existsSync(join(server.dir, '.syncignore')) && readFileSync(join(server.dir, '.syncignore'), 'utf8'),
	).not.toContain('mine.ts')
	expect([read(client, 'mine.ts'), read(server, 'mine.ts')]).toEqual(['1', '2'])
	expect(pluginSyncClient.state.discrepancies).toEqual([])
	expect(pluginSyncClient.state.excluded).toContainEqual({ file: 'mine.ts', by: 'client' })
	// Removing the exclusion resumes comparing.
	writeFileSync(join(client.dir, '.syncignore'), '')
	await pluginSyncClient.compare()
	expect(one('mine.ts')).toBeDefined()
})

test('the same home compares nothing; file names cannot leave the plugins directory', async () => {
	server = { ...server, home: client.home }
	put(client, 'a.ts', '1')
	await pluginSyncClient.compare()
	expect(pluginSyncClient.state.same).toBe(true)
	expect(sent.map((c) => c.op)).toEqual(['inventory'])
	for (let file of [
		'../x.ts',
		'a/b.ts',
		'x.d.ts',
		'x.js',
		'personal/../x.ts',
		'personal/a/b.ts',
		'personal/\\x.ts',
		'personal/.ts',
		'../USER.md',
		'personal/USER.md',
		'user.md',
	])
		expect(commandCheck.invalid({ type: 'sync', op: 'fetch', file, known: [] })).toContain('plugin or home filename')
})

test('comparisons asked for while one runs collapse into one more', async () => {
	put(server, 'a.ts', '1')
	let runs = 0
	let real = pluginSyncClient.run
	pluginSyncClient.run = async () => (runs++, real())
	try {
		await Promise.all([pluginSyncClient.compare(), pluginSyncClient.compare(), pluginSyncClient.compare()])
	} finally {
		pluginSyncClient.run = real
	}
	expect(runs).toBe(2)
})
