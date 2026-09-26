import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type { Event } from '../common/protocol.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import { commands } from './commands.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'
import { synthetic } from './synthetic.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
const saved = { dir: commands.dir, home: commands.home }
const origModels = synthetic.models
let home = ''
let work = ''

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-commands-`)
	work = `${home}/work`
	mkdirSync(`${work}/projects/a`, { recursive: true })
	mkdirSync(`${work}/projection`)
	mkdirSync(`${work}/.hidden`)
	writeFileSync(`${work}/project.txt`, '')
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	commands.home = () => work
	synthetic.models = { ...origModels }
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	Object.assign(commands, saved)
	synthetic.models = origModels
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

function client() {
	let events: Event[] = []
	let views = new Map<string, Transcript>()
	let conn = host.connect((e) => {
		events.push(e)
		let id = 'sessionId' in e ? e.sessionId : undefined
		if (id) {
			let t = transcript.fold(views.get(id), e)
			if (t) views.set(id, t)
		}
	})
	return { conn, events, views, of: (type: string) => events.filter((e) => e.type === type) as any[] }
}

async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return
		await new Promise((r) => setTimeout(r, 1))
	}
	throw new Error('timed out')
}

function created(c: ReturnType<typeof client>, model = 'hal/intro'): string {
	c.conn.send({ type: 'create', cwd: work, model })
	return c.of('snapshot').at(-1).sessionId
}

async function opened(id: string) {
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.views.get(id))
	return c
}

const outputs = (t: Transcript) => t.items.flatMap((i) => (i.type === 'output' ? [i.text] : []))

test('/cd changes the session cwd for every follower; a relative path resolves from the old cwd', async () => {
	let a = client()
	let id = created(a)
	let b = await opened(id)
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd projects/a' })
	await until(() => b.views.get(id)!.meta.cwd === `${work}/projects/a`)
	expect(sessions.open(id).cwd).toBe(`${work}/projects/a`)
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd ~/projection' })
	await until(() => b.views.get(id)!.meta.cwd === `${work}/projection`)
	expect(a.views.get(id)!.state).toEqual({ type: 'idle' })
	expect(a.of('turn-start')).toEqual([])
	// Commands and what they said are shown, not sent to the model.
	expect(b.views.get(id)!.items.filter((i) => i.type === 'command').map((i: any) => i.text)).toEqual(['/cd projects/a', '/cd ~/projection'])
	expect(await history.messages(id)).toEqual([])
	expect((await opened(id)).views.get(id)).toEqual(b.views.get(id))
})

test('/cd to a missing directory asks; any client answers, yes creates it and changes to it', async () => {
	let a = client()
	let id = created(a)
	let b = await opened(id)
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd new/place' })
	await until(() => transcript.question(b.views.get(id)))
	let q = transcript.question(b.views.get(id))!
	expect(q.form.text).toContain(`${work}/new/place`)
	expect(b.views.get(id)!.state).toEqual({ type: 'blocked', reason: 'question' })
	expect(existsSync(`${work}/new`)).toBe(false)
	b.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { create: 'yes' } })
	a.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { create: 'no' } })
	expect(a.of('rejected').at(-1)).toMatchObject({ command: 'answer' })
	await until(() => a.views.get(id)!.meta.cwd === `${work}/new/place`)
	expect(statSync(`${work}/new/place`).isDirectory()).toBe(true)
	expect(a.views.get(id)!.state).toEqual({ type: 'idle' })
	expect(a.of('turn-start')).toEqual([])
	expect((await opened(id)).views.get(id)).toEqual(a.views.get(id))
})

test('a command question survives a restart; no answers it and nothing changes', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd nowhere' })
	await until(() => transcript.question(a.views.get(id)))
	let q = transcript.question(a.views.get(id))!
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	await host.recover()
	let b = await opened(id)
	expect(b.views.get(id)!.state).toEqual({ type: 'blocked', reason: 'question' })
	expect(b.of('turn-start')).toEqual([])
	b.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { create: 'no' } })
	await until(() => b.views.get(id)!.state.type === 'idle')
	expect(existsSync(`${work}/nowhere`)).toBe(false)
	expect(b.views.get(id)!.meta.cwd).toBe(work)
})

test('Escape on a command question dismisses it and the session returns to its state; a prompt sent meanwhile then runs', async () => {
	synthetic.models.ok = () => ({ say: 'ok' })
	let a = client()
	let id = created(a, 'hal/ok')
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd nowhere' })
	await until(() => transcript.question(a.views.get(id)))
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	expect(a.views.get(id)!.inbox.map((m) => m.text)).toEqual(['hi'])
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	let view = a.views.get(id)!
	expect(view.items.find((i) => i.type === 'question')).toMatchObject({ cancelled: true })
	expect(view.items.filter((i) => i.type === 'turn-end')).toHaveLength(1)
	expect(view.inbox).toEqual([])
	expect(existsSync(`${work}/nowhere`)).toBe(false)
	expect((await opened(id)).views.get(id)).toEqual(view)
})

test('/help lists every command by category and /help <name> shows its detail', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: '/help' })
	await until(() => outputs(a.views.get(id)!).length)
	let list = outputs(a.views.get(id)!)[0]!
	for (let [name, c] of commands.all()) {
		expect(list).toContain(`/${name}`)
		expect(list).toContain(c.description)
		expect(list).toContain(c.category)
	}
	a.conn.send({ type: 'submit', sessionId: id, text: '/help cd' })
	await until(() => outputs(a.views.get(id)!).length === 2)
	expect(outputs(a.views.get(id)!)[1]).toBe(commands.all().get('cd')!.help!(''))
	a.conn.send({ type: 'submit', sessionId: id, text: '/help nope' })
	await until(() => a.views.get(id)!.items.some((i) => i.type === 'output' && i.error))
})

test('an unknown command is refused; text that only starts with a path is a prompt', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: '/nope x' })
	expect(a.of('rejected').at(-1)).toMatchObject({ command: 'submit', reason: expect.stringMatching(/unknown command/) })
	a.conn.send({ type: 'submit', sessionId: id, text: '/tmp/x is broken' })
	await until(() => a.of('turn-start').length)
})

test('a command runs while a turn is busy instead of waiting in the inbox', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => transcript.question(a.views.get(id)))
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd projects' })
	await until(() => a.views.get(id)!.meta.cwd === `${work}/projects`)
	expect(a.views.get(id)!.inbox).toEqual([])
	expect(a.views.get(id)!.state).toEqual({ type: 'blocked', reason: 'question' })
})

test('history records who sent a command', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: '/help', from: '7-abc' })
	a.conn.send({ type: 'submit', sessionId: id, text: '/help cd' })
	let cmds = history.readSync(id).filter((r) => r.type === 'command')
	expect(cmds.map((r: any) => r.from)).toEqual(['7-abc', undefined])
	await until(() => a.views.get(id)!.items.filter((i) => i.type === 'command').length === 2)
	expect(a.views.get(id)!.items.find((i) => i.type === 'command')).toMatchObject({ from: '7-abc' })
})

test('completion runs on the host against its files, answering only the asker', async () => {
	let a = client()
	let id = created(a)
	let b = await opened(id)
	let ask = (text: string) => {
		a.conn.send({ type: 'complete', sessionId: id, text })
		return a.of('completions').at(-1)
	}
	expect(ask('/c').items).toEqual(['/cd '])
	expect(ask('/cd ~/projec').items.sort()).toEqual(['/cd ~/projection/', '/cd ~/projects/'])
	expect(ask('/cd projects/').items).toEqual(['/cd projects/a/'])
	expect(ask('/cd ~/.h').items).toEqual(['/cd ~/.hidden/'])
	expect(ask('/cd ~/').items.sort()).toEqual(['/cd ~/projection/', '/cd ~/projects/'])
	expect(ask('/help c').items).toEqual(['/help cd'])
	expect(ask('/nope x').items).toEqual([])
	expect(ask('/cd ~/projec')).toMatchObject({ sessionId: id, text: '/cd ~/projec' })
	expect(b.of('completions')).toEqual([])
})

test('commands are the files in the commands directory', () => {
	let dir = `${home}/cmds`
	mkdirSync(dir)
	writeFileSync(`${dir}/hello-there.ts`, `export const command = { description: 'says hi', category: 'fun', run: () => ({ say: 'hi' }) }\n`)
	writeFileSync(`${dir}/hello.test.ts`, '')
	commands.dir = () => dir
	expect([...commands.all().keys()]).toEqual(['hello-there'])
	expect(commands.parse('/hello-there  a b')).toEqual({ name: 'hello-there', args: 'a b' })
})

test('every shipped command has a description, a category and run', () => {
	expect(commands.all().size).toBeGreaterThanOrEqual(2)
	for (let c of commands.all().values()) {
		expect(c.description).toBeString()
		expect(c.category).toBeString()
		expect(c.run).toBeFunction()
	}
})
