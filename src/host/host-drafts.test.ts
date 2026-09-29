// Drafts and optimistic sending against the real host, through the
// common connection and client drafts (tasks/j1/states.md, Drafts and
// sending): typed text survives a host restart, a disconnect and a
// client crash, and a prompt is submitted exactly once.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type { StreamEvent } from '../common/blocks.ts'
import { connection, type Transport } from '../common/connection.ts'
import { drafts, type Local } from '../common/drafts.ts'
import type { Draft, Event } from '../common/protocol.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { turns } from './turns.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'

const savedHome = process.env.HAL_HOME
const origStream = turns.stream
const origStore = drafts.store
const origSchedule = connection.schedule
const origOnError = liveFiles.onError
let home = ''
let id = ''

// The client's local copies, as a file would keep them across a crash.
let stored = new Map<string, string>()
// Whether the host answers, and a way to cut the current connection.
let up = true
let cut: (() => void) | null = null
// Events after this many are lost with the connection (null: none).
let loseAfter: ((e: Event) => boolean) | null = null
let retries: (() => void)[] = []
let events: Event[] = []

const transport: Transport = {
	connect: async (on) => {
		if (!up) return null
		let lost = false
		let conn = host.connect((e) => {
			if (lost) return
			if (loseAfter?.(e)) {
				lost = true
				return queueMicrotask(() => cut?.())
			}
			on.event(e)
		})
		cut = () => {
			cut = null
			conn.close()
			on.dropped()
		}
		return { conn, role: 'client' }
	},
}

const tick = () => Bun.sleep(0)
async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return
		await Bun.sleep(1)
	}
	throw new Error('timed out')
}

// Starts (or restarts, after a crash) the client and opens the session.
async function client(): Promise<void> {
	drafts.reset()
	await connection.start({
		transport,
		onEvent: (e) => {
			events.push(e)
			drafts.onEvent(e)
		},
		baseMs: 1,
		maxMs: 1,
	})
	connection.send({ type: 'open', sessionId: id })
	await until(() => events.some((e) => e.type === 'snapshot'))
}

// Another client (the phone), speaking the protocol directly.
function phone() {
	let p = { draft: undefined as Draft | undefined, send: (_c: object) => {} }
	let conn = host.connect((e) => {
		if (e.type === 'snapshot') p.draft = e.snapshot.draft
		if (e.type === 'draft') p.draft = e.draft
	})
	p.send = (c) => conn.send(c)
	p.send({ type: 'open', sessionId: id })
	return p
}

const userRecords = () => history.readSync(id).filter((r) => r.type === 'user')

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-drafts-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	turns.stream = async function* (): AsyncGenerator<StreamEvent> {
		yield { type: 'text', text: 'ok' }
		yield { type: 'done', reason: 'end' }
	}
	stored = new Map()
	drafts.store = {
		load: (s) => (stored.has(s) ? (JSON.parse(stored.get(s)!) as Local) : undefined),
		save: (s, l) => void stored.set(s, JSON.stringify(l)),
	}
	connection.schedule = (fn) => (retries.push(fn), 0 as any)
	up = true
	loseAfter = null
	retries = []
	events = []
	id = sessions.create({ cwd: '/tmp', model: 'fake/m' }).id
})

afterEach(() => {
	connection.stop()
	host.reset()
	sessions.closeAll()
	drafts.reset()
	drafts.store = origStore
	turns.stream = origStream
	connection.schedule = origSchedule
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

test('host restart while typing: the draft is still there', async () => {
	await client()
	drafts.edit(id, 'half a thou')
	drafts.edit(id, 'half a thought')
	await tick()
	// The host restarts: it forgets everything but what is on disk.
	cut!()
	host.reset()
	sessions.closeAll()
	drafts.reset()
	stored.clear()
	retries.shift()?.()
	events = []
	await client()
	expect(drafts.text(id)).toBe('half a thought')
})

test('typing while disconnected is kept, and synced on reconnect', async () => {
	await client()
	up = false
	cut!()
	await tick()
	drafts.edit(id, 'offline words')
	expect(JSON.parse(stored.get(id)!).text).toBe('offline words')
	up = true
	retries.shift()!()
	await until(() => phone().draft?.text === 'offline words')
})

test('disconnect then send: pending until acknowledged, submitted once', async () => {
	await client()
	drafts.edit(id, 'hello')
	up = false
	cut!()
	await tick()
	drafts.submit(id, 'hello')
	expect(drafts.pending(id).map((s) => s.text)).toEqual(['hello'])
	expect(drafts.text(id)).toBe('')
	// Not acknowledged: kept locally, and the host's draft still holds it.
	expect(JSON.parse(stored.get(id)!).sending).toHaveLength(1)
	expect(phone().draft?.text).toBe('hello')
	up = true
	retries.shift()!()
	await until(() => drafts.pending(id).length === 0)
	expect(userRecords()).toHaveLength(1)
	expect(phone().draft?.text).toBe('')
	expect(JSON.parse(stored.get(id)!).sending).toEqual([])
})

test('client crash before the acknowledgement: resent once, never twice', async () => {
	await client()
	drafts.edit(id, 'important')
	await tick()
	// The host takes the prompt, but the ack never arrives.
	loseAfter = (e) => e.type === 'ack'
	drafts.submit(id, 'important')
	await until(() => userRecords().length === 1)
	// Crash: memory gone, the local store survives.
	connection.stop()
	loseAfter = null
	events = []
	await client()
	await until(() => drafts.pending(id).length === 0)
	expect(userRecords()).toHaveLength(1)
	expect(drafts.text(id)).toBe('')
})

test('client crash before the host had the prompt: sent after restart', async () => {
	await client()
	up = false
	cut!()
	await tick()
	drafts.submit(id, 'never arrived')
	connection.stop()
	up = true
	events = []
	await client()
	await until(() => drafts.pending(id).length === 0)
	expect(userRecords().map((r) => (r.type === 'user' && r.blocks[0]?.type === 'text' ? r.blocks[0].text : ''))).toEqual(['never arrived'])
})

test('a refused prompt goes back into the editor, before text typed since', async () => {
	await client()
	let origSubmit = prompts.submit
	prompts.submit = () => 'disk full'
	try {
		up = false
		cut!()
		await tick()
		drafts.submit(id, 'lost?')
		drafts.edit(id, 'typed on')
		up = true
		retries.shift()!()
		await until(() => events.some((e) => e.type === 'rejected'))
	} finally {
		prompts.submit = origSubmit
	}
	expect(drafts.pending(id)).toEqual([])
	expect(drafts.text(id)).toBe('lost?\ntyped on')
	expect(phone().draft?.text).toBe('lost?\ntyped on')
})

test('a prompt sent while a turn runs steers it, and is pending until the host has it', async () => {
	await client()
	turns.stream = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamEvent>>(() => {}) }) })
	drafts.submit(id, 'first')
	drafts.submit(id, 'later', true)
	await until(() => drafts.pending(id).length === 0)
	expect(history.readSync(id).filter((r) => r.type === 'inbox')).toMatchObject([{ text: 'later', queue: true }])
	host.reset()
})

test('edits made apart on two clients are both kept', async () => {
	await client()
	let p = phone()
	drafts.edit(id, 'base')
	let base = p.draft!.rev
	up = false
	cut!()
	await tick()
	drafts.edit(id, 'laptop text')
	p.send({ type: 'draft', sessionId: id, text: 'phone text', base })
	up = true
	retries.shift()!()
	await until(() => drafts.text(id).includes('phone text') && drafts.text(id).includes('laptop text'))
	expect(p.draft!.text).toBe(drafts.text(id))
})

test('a repeated draft command changes nothing', async () => {
	let p = phone()
	let seen: Event[] = []
	let conn = host.connect((e) => seen.push(e))
	conn.send({ type: 'open', sessionId: id })
	conn.send({ type: 'draft', sessionId: id, text: 'once', base: 0, id: 'c.1' })
	p.send({ type: 'draft', sessionId: id, text: 'once, and more', base: 1 })
	conn.send({ type: 'draft', sessionId: id, text: 'once', base: 0, id: 'c.1' })
	expect(p.draft).toEqual({ text: 'once, and more', rev: 2 })
	expect(seen.filter((e) => e.type === 'ack')).toHaveLength(2)
})

test('a draft the host already holds settles instead of being resent forever', async () => {
	await client()
	let p = phone()
	up = false
	cut!()
	await tick()
	drafts.edit(id, '/statu')
	p.send({ type: 'draft', sessionId: id, text: '/statu', base: 0 })
	up = true
	retries.shift()!()
	await until(() => events.some((e) => e.type === 'ack'))
	await tick()
	let sent = events.filter((e) => e.type === 'ack').length
	drafts.edit(id, '/status')
	expect(p.draft?.text).toBe('/status')
	expect(events.filter((e) => e.type === 'ack').length).toBe(sent + 1)
})
