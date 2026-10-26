// The remote terminal's plugin review (task b81) between two homes in
// one process, as in plugin-sync.test.ts: the indicator and notices
// follow the comparison without moving focus, Never sync drops a file
// from the count, a stale answer writes nothing and asks again, and
// changes on both sides merge or are left to merge by hand.
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
import { paths } from './paths.ts'

type Side = { home: string; dir: string; hist: typeof pluginHistory.state; files: Map<string, Loaded> }

const saved = {
	hist: pluginHistory.state,
	files: plugins.state.files,
	home: paths.state.home,
	send: pluginSyncClient.send,
	report: plugins.report,
	deliver: pluginReports.deliver,
	onChange: pluginSyncClient.onChange,
	onReview: pluginSyncClient.onReview,
	show: pluginSyncReview.show,
}
let root = '',
	client: Side,
	server: Side
let sent: any[] = [],
	steps: any[] = [],
	notices: any[] = [],
	shown: (string | undefined)[] = []

function makeSide(name: string): Side {
	let home = join(root, name),
		dir = join(home, 'plugins')
	mkdirSync(dir, { recursive: true })
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
	pluginHistory.init(dir)
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

function put(s: Side, file: string, text: string): void {
	on(s, () => {
		let path = join(s.dir, file)
		writeFileSync(path, text)
		pluginHistory.seen(path)
		s.files.set(path, { path, hash: '', hooks: [], portable: true })
	})
}

const read = (s: Side, file: string) =>
	existsSync(join(s.dir, file)) ? readFileSync(join(s.dir, file), 'utf8') : undefined

// The host answers as host.ts would; review steps are collected.
function answer(c: any): void {
	if (c.op === 'step') return void steps.push(c)
	let events: Event[] = [
		on(server, () => pluginSync.command({ deliver: () => {} }, c)).reply,
		{ type: 'ack', id: c.id },
	]
	queueMicrotask(() => events.forEach((e) => pluginSyncClient.event(e)))
}

// One review step in session `s`, as the host's turn would ask for it.
async function step(answers?: Record<string, string>) {
	let before = steps.length
	pluginSyncClient.event({ type: 'sync', review: 's', ...(answers ? { answers } : {}) })
	while (steps.length === before) await Bun.sleep(1)
	return steps.at(-1)
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'hal-plugin-review-'))
	plugins.report = () => {}
	server = makeSide('server')
	client = makeSide('client')
	sent = []
	steps = []
	notices = []
	shown = []
	pluginReports.deliver = (e) => void notices.push(e)
	pluginSyncReview.state = { asked: new Map(), later: new Map(), announced: new Set() }
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
	if (saved.home === undefined) paths.state.home = undefined
	else paths.state.home = saved.home
	plugins.report = saved.report
})

test('startup shows a count and one notice, never focus; Never sync drops a file until synced again', async () => {
	put(client, 'theme.ts', 'export const portable = true // dark')
	put(server, 'theme.ts', 'export const portable = true // light')
	put(client, 'keys.ts', 'export const portable = true // mine')
	await pluginSyncClient.compare()
	expect(shown.at(-1)).toBe('Files differ (2) — /sync')
	expect(notices).toHaveLength(1)
	expect(notices[0]).toMatchObject({ type: 'notice', key: 'sync', line: 'keys.ts, theme.ts — /sync' })
	expect(sent.every((c) => c.type === 'sync' && c.op !== 'step')).toBe(true)
	await pluginSyncClient.compare()
	expect(notices).toHaveLength(1)

	let first = await step()
	let never = first.ask.fields[0].options.at(-1)
	expect(first.ask.fields[0].options).toEqual(['Copy to example.com', 'Delete here', 'Not now', never])
	expect(never).toStartWith('Never sync keys.ts on ')
	expect(first.ask.fields[0].initial).toBe(0)
	expect(first.ask.skip).toBe(true)
	expect(first.say).toContain('example.com**) never had it')
	expect(first.say).not.toContain('```diff')
	let next = await step({ choice: never })
	expect(next.say).toContain('no longer syncs keys.ts')
	expect(readFileSync(join(client.dir, '.syncignore'), 'utf8')).toBe('keys.ts\n')
	expect(read(server, 'keys.ts')).toBeUndefined()
	expect(shown.at(-1)).toBe('Files differ (1) — /sync')
	expect(next.ask.fields[0].outcomes.join('\n')).toContain('```combined-diff\n')
	expect(next.ask.text).toBe('Sync theme.ts?')

	// Escape (no answer) is Not now: the file waits for the next /sync,
	// and the never-synced file can be synced again.
	let last = await step()
	expect(last.say).toContain('Skipped for now: theme.ts.')
	expect(last.ask.fields[0].options).toEqual(['Sync keys.ts again', 'Done'])
	let again = await step({ choice: 'Sync keys.ts again' })
	expect(readFileSync(join(client.dir, '.syncignore'), 'utf8')).toBe('')
	expect(again.ask.text).toBe('Sync keys.ts?')
})

test('a stale answer writes nothing and asks about the revised versions', async () => {
	put(server, 'theme.ts', 'export const portable = true // light')
	put(client, 'theme.ts', 'export const portable = true // dark')
	await pluginSyncClient.compare()
	await step()
	put(server, 'theme.ts', 'export const portable = true // solarized')
	let again = await step({ choice: "Use example.com's copy" })
	expect(again.say).toContain('changed on the server since it was compared; nothing was written')
	expect(read(server, 'theme.ts')).toBe('export const portable = true // solarized')
	// Taking the server's copy previews only the server's changes, in its
	// column, under a legend of only the marks shown.
	let field = again.ask.fields[0]
	let preview = field.outcomes[field.options.indexOf("Use example.com's copy")]
	expect(preview).toContain('```combined-diff\n + example.com added\n\n')
	expect(preview).not.toContain('deleted')
	expect(preview).toContain('\n +export const portable = true // solarized')

	let done = await step({ choice: "Use example.com's copy" })
	expect(done.say).toContain('for theme.ts:')
	expect(read(client, 'theme.ts')).toBe('export const portable = true // solarized')
	expect(done.say).toContain('Synced files match example.com.')
	expect(done.ask).toBeUndefined()
	expect(shown.at(-1)).toBeUndefined()
})

test('changes on both sides merge, or wait beside the file to be merged by hand', async () => {
	put(client, 'notes.ts', 'a\nb\nc\nd\ne\n')
	await pluginSyncClient.compare()
	await step({ choice: (await step()).ask.fields[0].options[0] })
	put(client, 'notes.ts', 'A\nb\nc\nd\ne\n')
	put(server, 'notes.ts', 'a\nb\nc\nd\nE\n')
	let q = await step()
	expect(q.say).toContain('Both have changes to **notes.ts**; they merge cleanly.')
	expect(q.ask.fields[0].options[0]).toBe('Use both changes')
	expect(q.ask.fields[0].initial).toBe(0)
	await step({ choice: q.ask.fields[0].options[0] })
	expect(read(client, 'notes.ts')).toBe('A\nb\nc\nd\nE\n')
	expect(read(server, 'notes.ts')).toBe('A\nb\nc\nd\nE\n')

	// Changes on one side only start on taking them; there is no merge.
	put(client, 'notes.ts', 'A\nB\nc\nd\nE\n')
	let ff = await step()
	expect(ff.ask.fields[0].options[ff.ask.fields[0].initial]).toEndWith("'s changes")
	await step({ choice: 'Not now' })

	put(client, 'notes.ts', 'mine\nb\nc\nd\nE\n')
	put(server, 'notes.ts', 'theirs\nb\nc\nd\nE\n')
	q = await step()
	expect(q.say).toContain('incompatible changes to **notes.ts** in 1 place')
	expect(read(client, 'notes.ts.server')).toBe('theirs\nb\nc\nd\nE\n')
	expect(q.ask.fields[0].options).toContain('I merged it myself')
	put(client, 'notes.ts', 'both\nb\nc\nd\nE\n')
	await step({ choice: 'I merged it myself' })
	expect(read(server, 'notes.ts')).toBe('both\nb\nc\nd\nE\n')
	expect(read(client, 'notes.ts.server')).toBeUndefined()
})
