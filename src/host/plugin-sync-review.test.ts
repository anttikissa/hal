// The remote terminal's plugin review (task b81) between two homes in
// one process, as in plugin-sync.test.ts: the indicator and notices
// follow the comparison without moving focus, Keep separate drops a
// file from the count, and a stale answer writes nothing and asks again.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Event } from '../common/protocol.ts'
import { pluginHistory } from './plugin-history.ts'
import { pluginReports } from './plugin-reports.ts'
import { pluginSync } from './plugin-sync.ts'
import { pluginSyncClient } from './plugin-sync-client.ts'
import { pluginSyncReview } from './plugin-sync-review.ts'
import { plugins, type Loaded } from './plugins.ts'

type Side = { home: string; dir: string; hist: typeof pluginHistory.state; files: Map<string, Loaded> }

const saved = { hist: pluginHistory.state, files: plugins.state.files, home: process.env.HAL_HOME, send: pluginSyncClient.send, report: plugins.report, deliver: pluginReports.deliver, onChange: pluginSyncClient.onChange, onReview: pluginSyncClient.onReview, show: pluginSyncReview.show }
let root = '', client: Side, server: Side
let sent: any[] = [], steps: any[] = [], notices: any[] = [], shown: (string | undefined)[] = []

function makeSide(name: string): Side {
	let home = join(root, name), dir = join(home, 'plugins')
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

function put(s: Side, file: string, text: string): void {
	on(s, () => {
		let path = join(s.dir, file)
		writeFileSync(path, text)
		pluginHistory.seen(path)
		s.files.set(path, { path, hash: '', hooks: [], portable: true })
	})
}

const read = (s: Side, file: string) => (existsSync(join(s.dir, file)) ? readFileSync(join(s.dir, file), 'utf8') : undefined)

// The host answers as host.ts would; review steps are collected.
function answer(c: any): void {
	if (c.op === 'step') return void steps.push(c)
	let events: Event[] = [on(server, () => pluginSync.command({ deliver: () => {} }, c)).reply, { type: 'ack', id: c.id }]
	queueMicrotask(() => events.forEach((e) => pluginSyncClient.event(e)))
}

// One review step in session `s`, as the host's turn would ask for it.
async function step(answers?: Record<string, string>) {
	let before = steps.length
	pluginSyncClient.event({ type: 'plugin-sync', review: 's', ...(answers ? { answers } : {}) })
	while (steps.length === before) await Bun.sleep(1)
	return steps.at(-1)
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'hal-plugin-review-'))
	plugins.report = () => {}
	server = makeSide('server')
	client = makeSide('client')
	sent = []; steps = []; notices = []; shown = []
	pluginReports.deliver = (e) => void notices.push(e)
	pluginSyncReview.state = { asked: new Map(), announced: new Set() }
	pluginSyncReview.start('example.com', (text) => void shown.push(text))
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
	Object.assign(pluginSyncClient, { send: saved.send, onChange: saved.onChange, onReview: saved.onReview })
	Object.assign(pluginReports, { deliver: saved.deliver })
	pluginSyncReview.show = saved.show
	pluginHistory.state = saved.hist
	plugins.state.files = saved.files
	process.env.HAL_HOME = saved.home
	plugins.report = saved.report
})

test('startup shows a count and one notice, never focus; Keep separate drops a file from the count', async () => {
	put(client, 'theme.ts', 'export const portable = true // dark')
	put(server, 'theme.ts', 'export const portable = true // light')
	put(client, 'keys.ts', 'export const portable = true // mine')
	await pluginSyncClient.compare()
	expect(shown.at(-1)).toBe('Plugins differ (2) — /plugin-sync')
	expect(notices).toHaveLength(1)
	expect(notices[0]).toMatchObject({ type: 'notice', key: 'plugin-sync', line: 'keys.ts, theme.ts — /plugin-sync' })
	expect(sent.every((c) => c.type === 'plugin-sync' && c.op !== 'step')).toBe(true)
	await pluginSyncClient.compare()
	expect(notices).toHaveLength(1)

	let first = await step()
	expect(first.ask.fields[0].options).toEqual(['Use client version', 'Use server version', 'Keep separate — ignore sync for keys.ts on this client'])
	expect(first.say).toContain('missing (no history of this file)')
	let next = await step({ choice: 'Keep separate — ignore sync for keys.ts on this client' })
	expect(next.say).toContain('Keeping keys.ts separate')
	expect(readFileSync(join(client.dir, '.syncignore'), 'utf8')).toBe('keys.ts\n')
	expect(read(server, 'keys.ts')).toBeUndefined()
	expect(shown.at(-1)).toBe('Plugins differ (1) — /plugin-sync')
	expect(next.say).toContain('```diff\n')
	expect(next.ask.text).toStartWith('theme.ts')
})

test('a stale answer writes nothing and asks about the revised versions', async () => {
	put(server, 'theme.ts', 'export const portable = true // light')
	put(client, 'theme.ts', 'export const portable = true // dark')
	await pluginSyncClient.compare()
	await step()
	put(server, 'theme.ts', 'export const portable = true // solarized')
	let again = await step({ choice: 'Use client version' })
	expect(again.say).toContain('changed on the server since it was compared; nothing was written')
	expect(read(server, 'theme.ts')).toBe('export const portable = true // solarized')
	expect(again.say).toContain('+export const portable = true // dark')
	expect(again.ask.text).toStartWith('theme.ts')

	let done = await step({ choice: 'Use server version' })
	expect(done.say).toStartWith('Used the server version of theme.ts: this client applied it.')
	expect(read(client, 'theme.ts')).toBe('export const portable = true // solarized')
	expect(done.say).toContain('Portable plugins match example.com.')
	expect(done.ask).toBeUndefined()
	expect(shown.at(-1)).toBeUndefined()
})
