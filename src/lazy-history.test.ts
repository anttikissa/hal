// Lazy history (task bq) end to end in one process: the host sends the
// tail, and the terminal fetches the rest in the background and ends up
// showing exactly what a full load shows.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { drafts } from './common/drafts.ts'
import type { Event } from './common/protocol.ts'
import { transcript } from './common/transcript.ts'
import { app } from './client/app.ts'
import { appView } from './client/app-view.ts'
import { frame } from './client/frame.ts'
import { render } from './client/render.ts'
import { history } from './host/history.ts'
import { host } from './host/host.ts'
import { liveFiles } from './host/live-file.ts'
import { pages } from './host/pages.ts'
import { sessions } from './host/sessions.ts'

const savedHome = process.env.HAL_HOME
const saved = { send: app.send, show: render.show, budget: pages.budget, draftSend: drafts.send, onError: liveFiles.onError }
let home = ''

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-lazy-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	render.show = () => {}
	drafts.send = () => {}
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	pages.reset()
	app.reset()
	Object.assign(app, { send: saved.send })
	Object.assign(pages, { budget: saved.budget })
	Object.assign(drafts, { send: saved.draftSend })
	render.show = saved.show
	liveFiles.onError = saved.onError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

// A long session: turns with tool calls, a slash command, an edited
// prompt, and at the end a turn that asked a question and waits.
function longSession(): string {
	let id = sessions.create({ cwd: '/', model: 'fake/m' }).id
	for (let i = 0; i < 40; i++) {
		history.submit(id, `prompt ${i}`)
		history.append(id, { type: 'assistant', block: { type: 'tool_call', id: `t${i}`, name: 'read', input: { path: `/f${i}` } } })
		history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: `t${i}`, output: `line\n`.repeat(50 + i) }] })
		history.append(id, { type: 'assistant', block: { type: 'text', text: `answer ${i} `.repeat(30) } })
		history.append(id, { type: 'turn_end', status: 'completed', usage: { input: i, output: 1 } })
		if (i === 10) {
			history.append(id, { type: 'command', text: '/cd /tmp' })
			history.append(id, { type: 'output', text: 'now in /tmp' })
		}
		if (i === 20) history.append(id, { type: 'user', blocks: [{ type: 'text', text: `prompt ${i} edited` }], replaces: true })
	}
	history.submit(id, 'the last prompt')
	history.append(id, { type: 'question', id: 'q1', form: { text: 'Allow?', fields: [{ type: 'choice', name: 'ok', options: ['yes', 'no'] }] } })
	for (let i = 0; i < 30; i++) history.append(id, { type: 'output', text: `waiting ${i} `.repeat(100) })
	return id
}

// The terminal following the session through an in-process connection.
async function terminalShowing(id: string): Promise<{ lines: string[]; events: Event[] }> {
	app.reset()
	let events: Event[] = []
	let conn = host.connect((e) => {
		events.push(e)
		app.onEvent(e)
	})
	app.send = (c: any) => conn.send(c)
	conn.send({ type: 'open', sessionId: id })
	// Pages are asked for a macrotask apart; wait until they stop.
	for (let seen = -1; seen !== events.length; await Bun.sleep(1)) seen = events.length
	conn.close()
	return { lines: frame.build(appView.view(), 80, 24).lines, events }
}

test("the terminal's frame after the background load equals the frame from a full load", async () => {
	let id = longSession()
	await history.open(id)
	pages.budget = () => 10_000_000
	let full = await terminalShowing(id)
	expect(full.events.filter((e) => e.type === 'history')).toHaveLength(0)
	pages.budget = () => 8_000
	let lazy = await terminalShowing(id)
	let asked = lazy.events.filter((e) => e.type === 'history')
	expect(asked.length).toBeGreaterThan(3)
	expect(lazy.lines).toEqual(full.lines)
	expect(lazy.lines.join('\n')).toContain('prompt 0')
	expect(transcript.question(app.state.transcript)?.id).toBe('q1')
})

test('the open question shows at once, before the rest of the history is in', () => {
	let id = longSession()
	pages.budget = () => 8_000
	let snap: any
	let conn = host.connect((e) => {
		if (e.type === 'snapshot') snap = e.snapshot
	})
	conn.send({ type: 'open', sessionId: id })
	expect(snap.older).toBeGreaterThan(0)
	expect(snap.history.some((r: any) => r.type === 'question')).toBe(false)
	let t = transcript.fromSnapshot(snap)
	expect(transcript.question(t)?.id).toBe('q1')
	expect(t.items[0]).toMatchObject({ type: 'prompt', text: 'the last prompt' })
})

test('a page from a spot that is no record boundary is refused', async () => {
	let id = longSession()
	let events: Event[] = []
	let conn = host.connect((e) => void events.push(e))
	conn.send({ type: 'open', sessionId: id })
	await new Promise((r) => setTimeout(r, 5))
	conn.send({ type: 'history', sessionId: id, before: 3, id: 'h1' })
	expect(events.at(-1)).toMatchObject({ type: 'rejected', id: 'h1' })
	conn.send({ type: 'history', sessionId: id, before: -1, id: 'h2' })
	expect(events.at(-1)).toMatchObject({ type: 'rejected' })
})
