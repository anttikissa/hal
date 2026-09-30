import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import { commandList } from '../common/commands/list.ts'
import { keyHelp } from '../common/key-help.ts'
import { commands } from './commands.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { turns } from './turns.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'
import { synthetic } from './synthetic.ts'
import { chatgptLogin } from './login-chatgpt.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
const saved = { dir: commands.dir, home: commands.home }
const origModels = synthetic.models
const origStream = turns.stream
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
	turns.stream = origStream
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
	// A command's question is not the turn's: the state stays idle.
	expect(b.views.get(id)!.state).toEqual({ type: 'idle' })
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
	await turns.recover()
	let b = await opened(id)
	expect(transcript.question(b.views.get(id))?.id).toBe(q.id)
	expect(b.views.get(id)!.state).toEqual({ type: 'idle' })
	expect(b.of('turn-start')).toEqual([])
	b.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { create: 'no' } })
	await until(() => b.views.get(id)!.items.some((i) => i.type === 'question' && i.answers))
	expect(existsSync(`${work}/nowhere`)).toBe(false)
	expect(b.views.get(id)!.meta.cwd).toBe(work)
})

test('a command question lives beside turns: a prompt runs at once, the turn end leaves it open, Escape dismisses it', async () => {
	synthetic.models.ok = () => ({ say: 'ok' })
	let a = client()
	let id = created(a, 'hal/ok')
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd nowhere' })
	await until(() => transcript.question(a.views.get(id)))
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => a.of('turn-end').length)
	expect(a.views.get(id)!.inbox).toEqual([])
	expect(a.views.get(id)!.state).toEqual({ type: 'idle' })
	expect(transcript.question(a.views.get(id))).toBeTruthy()
	expect(transcript.question((await opened(id)).views.get(id))).toBeTruthy()
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => !transcript.question(a.views.get(id)))
	let view = a.views.get(id)!
	expect(view.items.find((i) => i.type === 'question')).toMatchObject({ cancelled: true })
	expect(existsSync(`${work}/nowhere`)).toBe(false)
	expect((await opened(id)).views.get(id)).toEqual(view)
})

test('a command question asked while a turn streams leaves the turn streaming; a newer one replaces it', async () => {
	let release = () => {}
	let held = new Promise<void>((r) => (release = r))
	turns.stream = () =>
		(async function* (): AsyncGenerator<StreamEvent> {
			yield { type: 'text', text: 'working' }
			await held
			yield { type: 'text', text: ' done' }
			yield { type: 'done', reason: 'end' }
		})()
	let a = client()
	let id = created(a, 'fake/m')
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd nowhere' })
	await until(() => transcript.question(a.views.get(id)))
	let first = transcript.question(a.views.get(id))!.id
	expect(a.views.get(id)!.live).toBeTruthy()
	expect(a.views.get(id)!.state).toEqual({ type: 'running', phase: 'streaming' })
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd elsewhere' })
	await until(() => transcript.question(a.views.get(id))?.id !== first)
	expect(a.views.get(id)!.items.find((i) => i.type === 'question' && i.id === first)).toMatchObject({ cancelled: true })
	release()
	await until(() => a.of('turn-end').length)
	expect(a.views.get(id)!.items.filter((i) => i.type === 'text').map((i: any) => i.text)).toEqual(['working done'])
	expect(transcript.question(a.views.get(id))).toBeTruthy()
	expect((await opened(id)).views.get(id)).toEqual(a.views.get(id))
})



test('the host refuses a client-only command, whoever sent it, and runs nothing', async () => {
	let a = client()
	let id = created(a)
	expect(prompts.submit(id, '/redraw', undefined, false, { from: '7-abc' })).toBe('only a client can run /redraw')
	a.conn.send({ type: 'submit', sessionId: id, text: '/quit' })
	expect(a.of('rejected').at(-1)).toMatchObject({ command: 'submit', reason: 'only a client can run /quit' })
	expect(history.readSync(id).filter((r) => r.type === 'command')).toEqual([])
})

test('an unknown command is refused; text that only starts with a path is a prompt', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: '/nope x' })
	expect(a.of('rejected').at(-1)).toMatchObject({ command: 'submit', reason: expect.stringMatching(/unknown command/) })
	a.conn.send({ type: 'submit', sessionId: id, text: '/tmp/x is broken' })
	await until(() => a.of('turn-start').length)
})

test('a command runs while a turn is busy instead of waiting in the inbox; /pause pauses it', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => transcript.question(a.views.get(id)))
	a.conn.send({ type: 'submit', sessionId: id, text: '/cd projects' })
	await until(() => a.views.get(id)!.meta.cwd === `${work}/projects`)
	expect(a.views.get(id)!.inbox).toEqual([])
	expect(a.views.get(id)!.state).toEqual({ type: 'blocked', reason: 'question' })
	a.conn.send({ type: 'submit', sessionId: id, text: '/pause' })
	await until(() => a.views.get(id)!.state.type === 'paused')
})

test('history records who sent a command', async () => {
	let a = client()
	let id = created(a)
	prompts.submit(id, '/help', undefined, false, { from: '7-abc' })
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
	// Other /c commands come and go; these two stay.
	expect(ask('/c').items).toEqual(expect.arrayContaining(['/cd ', '/close ']))
	expect(ask('/c').items.every((t: string) => t.startsWith('/c'))).toBe(true)
	expect(ask('/cd ~/projec').items.sort()).toEqual(['/cd ~/projection/', '/cd ~/projects/'])
	expect(ask('/cd projects/').items).toEqual(['/cd projects/a/'])
	expect(ask('/cd ~/.h').items).toEqual(['/cd ~/.hidden/'])
	expect(ask('/cd ~/').items.sort()).toEqual(['/cd ~/projection/', '/cd ~/projects/'])
	expect(ask('/help c').items).toEqual(expect.arrayContaining(['/help cd', '/help close']))
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

test('each listed command is run by exactly one side: a host file unless client-only', () => {
	let files = [...commands.all().keys()].sort()
	expect(files).toEqual(commandList.all().filter((c) => !c.clientOnly).map((c) => c.name).sort())
	for (let c of commands.all().values()) expect(c.run).toBeFunction()
})

test('no two commands share a key', () => {
	let keys = commandList.all().flatMap((c) => (c.key ? [JSON.stringify(keyHelp.parse(c.key))] : []))
	expect(keys.length).toBeGreaterThan(5)
	expect(new Set(keys).size).toBe(keys.length)
})

test('a bare /login chatgpt never turns an idle tab into a working turn, including after reopen', async () => {
	let original = chatgptLogin.run
	let pending: ((email: string) => void)[] = []
	chatgptLogin.run = (say) => {
		say('Open the device page and enter its code')
		return new Promise<string>((resolve) => pending.push(resolve))
	}
	try {
		let c = client()
		let id = created(c)
		tabs.insert(id, tabs.list().length)
		tabs.publish()
		c.conn.send({ type: 'submit', sessionId: id, text: '/login' })
		await until(() => transcript.question(c.views.get(id)))
		let q = transcript.question(c.views.get(id))!
		c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { method: 'ChatGPT subscription' } })
		await until(() => pending.length === 1)
		// The first device flow is still polling when a second /login succeeds.
		c.conn.send({ type: 'submit', sessionId: id, text: '/login' })
		await until(() => transcript.question(c.views.get(id))?.id !== q.id)
		q = transcript.question(c.views.get(id))!
		c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { method: 'ChatGPT subscription' } })
		await until(() => pending.length === 2)
		pending[1]!('test@example.com')
		await until(() => outputs(c.views.get(id)!).some((o) => o.includes('logged in')))
		pending[0]!('first@example.com')
		await until(() => outputs(c.views.get(id)!).some((o) => o.includes('first@example.com')))
		expect(status.stateOf(id)).toEqual({ type: 'idle' })
		expect(c.views.get(id)!.state).toEqual({ type: 'idle' })
		expect(tabs.list().find((t) => t.id === id)?.state).toEqual({ type: 'idle' })
		expect(c.of('tabs').at(-1)?.tabs.find((t: { id: string }) => t.id === id)?.state).toEqual({ type: 'idle' })
		let reopened = await opened(id)
		expect(reopened.views.get(id)!.state).toEqual({ type: 'idle' })
	} finally {
		chatgptLogin.run = original
	}
})
