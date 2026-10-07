// Plugin sync (task zh7) between two homes in one process: each side's
// plugin history and loaded-plugin table are swapped in around every
// call, and the client's commands reach the host handler directly.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { protocol, type Event } from '../common/protocol.ts'
import { pluginHistory } from './plugin-history.ts'
import { pluginSync } from './plugin-sync.ts'
import { pluginSyncClient, StaleError } from './plugin-sync-client.ts'
import { plugins, type Loaded } from './plugins.ts'

type Side = { home: string; dir: string; hist: typeof pluginHistory.state; files: Map<string, Loaded> }

const saved = { hist: pluginHistory.state, files: plugins.state.files, home: process.env.HAL_HOME, send: pluginSyncClient.send, report: plugins.report }
let root = '', client: Side, server: Side
let sent: any[] = []
// Drops the host's answers while true, as a lost connection would.
let lose = false

function makeSide(name: string, home = join(root, name)): Side {
	let dir = join(home, 'plugins')
	mkdirSync(dir, { recursive: true })
	let s: Side = { home, dir, hist: { dir: undefined, error: undefined, versions: new Map(), heads: new Map() }, files: new Map() }
	use(s)
	pluginHistory.init(dir)
	return s
}

function use(s: Side): void {
	pluginHistory.state = s.hist
	plugins.state.files = s.files
	process.env.HAL_HOME = s.home
}

function on<T>(s: Side, fn: () => T): T {
	use(s)
	try { return fn() } finally { use(client) }
}

// Writes (undefined: deletes) a portable plugin on side `s`.
function put(s: Side, file: string, text: string | undefined, portable = true): void {
	on(s, () => {
		let path = join(s.dir, file)
		if (text === undefined) { if (existsSync(path)) unlinkSync(path) } else writeFileSync(path, text)
		pluginHistory.seen(path)
		if (text !== undefined && portable) s.files.set(path, { path, hash: '', hooks: [], portable: true })
	})
}

const read = (s: Side, file: string) => (existsSync(join(s.dir, file)) ? readFileSync(join(s.dir, file), 'utf8') : undefined)
const ledger = (s: Side) => readFileSync(join(s.dir, 'history.asonl'), 'utf8')
const one = (file: string) => pluginSyncClient.state.discrepancies.find((d) => d.file === file)
const expected = (file: string) => ({ ...(one(file)!.client.id ? { client: one(file)!.client.id } : {}), ...(one(file)!.server.id ? { server: one(file)!.server.id } : {}) })
const host = { deliver: (_e: Event) => {} }

// The host answers as host.ts would: checked, then a reply and an ack.
function answer(c: any): void {
	let problem = protocol.invalid(c)
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
	rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
	pluginHistory.state = saved.hist
	plugins.state.files = saved.files
	process.env.HAL_HOME = saved.home
	pluginSyncClient.send = saved.send
	plugins.report = saved.report
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
	expect(one('base.ts')).toMatchObject({ relation: 'server-ahead', client: { status: 'missing' }, server: { status: 'present' } })
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
	put(server, 'gone.ts', undefined)
	put(server, 'blank.ts', '')
	await pluginSyncClient.compare()
	expect(one('gone.ts')).toMatchObject({ relation: 'server-ahead', client: { status: 'present' }, server: { status: 'deleted' } })
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
	expect(on(server, () => pluginSync.versionsOf('k.ts')).map((v) => v.hash).filter(Boolean)).toHaveLength(2)
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
	await expect(pluginSyncClient.apply('theirs.ts', 'client', { client: on(client, () => pluginSync.headOf('theirs.ts').id!) })).rejects.toThrow("excluded by the server's plugins/.syncignore")

	await pluginSyncClient.ignore('mine.ts')
	expect(readFileSync(join(client.dir, '.syncignore'), 'utf8')).toBe('mine.ts\n')
	expect(existsSync(join(server.dir, '.syncignore')) && readFileSync(join(server.dir, '.syncignore'), 'utf8')).not.toContain('mine.ts')
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
	for (let file of ['../x.ts', 'a/b.ts', 'x.d.ts', 'x.js'])
		expect(protocol.invalid({ type: 'plugin-sync', op: 'fetch', file, known: [] })).toContain('top-level plugin filename')
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
