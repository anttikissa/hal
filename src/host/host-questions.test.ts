import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type { Answers } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { turns } from './turns.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'
import { synthetic } from './synthetic.ts'
import { apiKeys } from './api-keys.ts'
import { auth } from './auth.ts'
import { config } from './config.ts'
import { paths } from './paths.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
const origModels = synthetic.models
const keyNames = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'SERPER_API_KEY'] as const
const savedKeys = keyNames.map((key) => process.env[key])
let home = ''

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-questions-`)
	process.env.HAL_HOME = home
	for (let key of keyNames) delete process.env[key]
	liveFiles.onError = () => {}
	synthetic.models = { ...origModels }
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	config.reset()
	auth.close()
	synthetic.models = origModels
	liveFiles.onError = origOnError
	keyNames.forEach((key, i) => {
		if (savedKeys[i] === undefined) delete process.env[key]
		else process.env[key] = savedKeys[i]
	})
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

// A client that records events and folds them into what it would show.
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
	c.conn.send({ type: 'create', cwd: '/tmp/w', model })
	return c.of('snapshot').at(-1).sessionId
}

async function opened(id: string) {
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.views.get(id))
	return c
}

const texts = (t: Transcript) => t.items.flatMap((i) => (i.type === 'text' ? [i.text] : []))

test('hal/intro asks a name, any client answers, the first answer wins and the model uses it', async () => {
	let a = client()
	let id = created(a)
	let b = await opened(id)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => transcript.question(b.views.get(id)))
	let q = transcript.question(b.views.get(id))!
	expect(q.form.text).toBe('How should I call you?')
	expect(a.views.get(id)!.state).toEqual({ type: 'blocked', reason: 'question' })
	expect(a.of('turn-end')).toEqual([])
	// A message sent meanwhile waits in the inbox; the question stays open.
	a.conn.send({ type: 'submit', sessionId: id, text: 'hello?' })
	expect(a.views.get(id)!.inbox.map((m) => m.text)).toEqual(['hello?'])
	expect(transcript.question((await opened(id)).views.get(id))?.id).toBe(q.id)

	b.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { name: 'Dave' } })
	a.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { name: 'Eve' } })
	expect(a.of('rejected').at(-1)).toMatchObject({ command: 'answer', reason: expect.stringMatching(/not open/) })
	await until(() => transcript.question(a.views.get(id))?.form.fields[0]?.name === 'about')
	let view = a.views.get(id)!
	expect(view.state).toEqual({ type: 'blocked', reason: 'question' })
	expect(texts(view)).toEqual(['Hello, I am Hal. Let us get acquainted; every question can be skipped.', 'Nice to meet you, Dave.'])
	expect(readFileSync(`${home}/USER.md`, 'utf8')).toContain('Name: Dave')
	expect(view.items.find((i) => i.type === 'question')).toMatchObject({ answers: { name: 'Dave' } })
	expect((await opened(id)).views.get(id)).toEqual(view)
	expect(b.views.get(id)).toEqual(view)
})

test('an open question survives a restart, is not continued by the new host, and its answer still works', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => transcript.question(a.views.get(id)))
	let q = transcript.question(a.views.get(id))!
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	await turns.recover()
	let b = await opened(id)
	expect(b.views.get(id)!.state).toEqual({ type: 'blocked', reason: 'question' })
	expect(transcript.question(b.views.get(id))?.id).toBe(q.id)
	expect(b.views.get(id)!.items.filter((i) => i.type === 'question')).toHaveLength(1)
	b.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { name: '' } })
	await until(() => transcript.question(b.views.get(id))?.form.fields[0]?.name === 'about')
	expect(texts(b.views.get(id)!).at(-1)).toBe('Glad to meet you.')
})

test('Escape while a question waits pauses the turn; continuing asks again', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => transcript.question(a.views.get(id)))
	let first = transcript.question(a.views.get(id))!
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.views.get(id)!.state.type === 'paused')
	expect(transcript.question(a.views.get(id))).toBeUndefined()
	a.conn.send({ type: 'answer', sessionId: id, question: first.id, answers: { name: 'late' } })
	expect(a.of('rejected').at(-1)).toMatchObject({ command: 'answer' })
	a.conn.send({ type: 'continue', sessionId: id })
	await until(() => transcript.question(a.views.get(id)))
	expect(transcript.question(a.views.get(id))!.id).not.toBe(first.id)
})

test('a secret reaches whoever asked but history only records that it was given; bad answers are refused', async () => {
	let heard: (Answers | undefined)[] = []
	synthetic.models.login = (records, answers) => {
		heard.push(answers)
		if (!records.some((r) => r.type === 'answer'))
			return { ask: { text: 'Log in', fields: [{ type: 'secret', name: 'key', label: 'API key' }, { type: 'choice', name: 'save', options: ['yes', 'no'] }] } }
		return { say: answers?.key ? 'logged in' : 'no key' }
	}
	let a = client()
	let id = created(a, 'hal/login')
	a.conn.send({ type: 'submit', sessionId: id, text: 'log me in' })
	await until(() => transcript.question(a.views.get(id)))
	let q = transcript.question(a.views.get(id))!
	for (let answers of [{ key: 'k' }, { key: 'k', save: 'maybe' }, { key: 'k', save: 'yes', extra: 'x' }, { key: 1, save: 'yes' }]) {
		a.conn.send({ type: 'answer', sessionId: id, question: q.id, answers })
	}
	expect(a.of('rejected')).toHaveLength(4)
	a.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { key: 'sk-SECRET', save: 'yes' } })
	await until(() => a.of('turn-end').length)
	expect(heard.at(-1)).toEqual({ key: 'sk-SECRET', save: 'yes' })
	expect(texts(a.views.get(id)!)).toEqual(['logged in'])
	expect(readFileSync(history.file(id), 'utf8')).not.toContain('sk-SECRET')
	expect(JSON.stringify(a.events)).not.toContain('sk-SECRET')
	expect(a.of('answer')[0]).toMatchObject({ answers: { save: 'yes' }, secrets: ['key'] })
})


test('intro resumes through name, about, login, model and secret search setup', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'hello' })
	let answer = async (field: string, value: string, next?: string) => {
		await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.name === field)
		let q = transcript.question(c.views.get(id))!
		c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { [field]: value } })
		if (next) await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.name === next)
	}
	await answer('name', 'Rowan', 'about')
	// A restart between steps keeps answers in history and the USER.md note.
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	let resumed = await opened(id)
	c = resumed
	await answer('about', 'Builds tools; likes short answers', 'login')
	expect(readFileSync(`${home}/USER.md`, 'utf8')).toBe('# User\n\nName: Rowan\n\n## About\n\nBuilds tools; likes short answers\n')
	expect(transcript.question(c.views.get(id))?.form.text).toMatch(/provider login/)
	await answer('login', 'Skip', 'model')
	let q = transcript.question(c.views.get(id))!
	let chosen = q.form.fields[0]!.type === 'choice' ? q.form.fields[0]!.options.find((x) => x.startsWith('anthropic/'))! : ''
	await answer('model', chosen, 'search')
	await answer('search', 'Yes', 'key')
	await answer('key', 'secret-SERPER-123')
	await until(() => c.of('turn-end').length > 0)
	expect(apiKeys.get('serper')).toBe('secret-SERPER-123')
	expect(statSync(paths.authFile()).mode & 0o777).toBe(0o600)
	expect(readFileSync(history.file(id), 'utf8')).not.toContain('secret-SERPER-123')
	expect(JSON.stringify(c.events)).not.toContain('secret-SERPER-123')
	expect(sessions.open(id).model).toBe(chosen)
	expect(readFileSync(paths.configFile(), 'utf8')).toContain(chosen)
	expect(texts(c.views.get(id)!).at(-1)).toMatch(/Escape pauses.*\/help.*web client/)
})

test('an existing user and accounts skip their questions, while a stored Serper key skips search', async () => {
	writeFileSync(`${home}/USER.md`, '# User\n\nName: Alex\n\n## About\n\nPrefers plain English.\n')
	apiKeys.save('serper', 'existing-key')
	apiKeys.save('opencode-go', 'existing-login')
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'start' })
	await until(() => transcript.question(c.views.get(id)))
	let q = transcript.question(c.views.get(id))!
	expect(q.form.fields[0]?.name).toBe('model')
	expect(texts(c.views.get(id)!)).toEqual(['Available logins: OpenCode Go.'])
	let chosen = q.form.fields[0]!.type === 'choice' ? q.form.fields[0]!.options[0]! : ''
	c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { model: chosen } })
	await until(() => c.of('turn-end').length)
	expect(readFileSync(`${home}/USER.md`, 'utf8')).toBe('# User\n\nName: Alex\n\n## About\n\nPrefers plain English.\n')
	expect(texts(c.views.get(id)!).at(-1)).toContain('You are ready.')
})


test('choosing provider login starts its real slash command, then the guide continues', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'start' })
	for (let [field, value] of [['name', ''], ['about', ''], ['login', '/login opencode']]) {
		await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.name === field)
		let q = transcript.question(c.views.get(id))!
		c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { [field!]: value! } })
	}
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.name === 'key')
	expect(c.of('command').at(-1)?.text).toBe('/login opencode')
	let q = transcript.question(c.views.get(id))!
	c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { key: 'test-key' } })
	await until(() => c.of('output').some((e: any) => e.text?.includes('logged in to OpenCode Go')))
	expect(apiKeys.get('opencode-go')).toBe('test-key')
	c.conn.send({ type: 'submit', sessionId: id, text: 'continue' })
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.name === 'model')
})
