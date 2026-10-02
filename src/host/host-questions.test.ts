import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type { HistoryRecord } from '../common/replay.ts'
import type { Answers } from '../common/forms.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { turns } from './turns.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'
import { synthetic } from './synthetic.ts'
import { clients } from './clients.ts'
import { intro } from './intro.ts'
import { profile } from './profile.ts'
import { apiKeys } from './api-keys.ts'
import { auth } from './auth.ts'
import { config } from './config.ts'
import { paths } from './paths.ts'
import { models } from './models.ts'
import { client, until } from './host-fixture.test.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
const origModels = synthetic.models
const origPause = synthetic.pauseMs
const origZones = [clients.timezone, clients.hostZone] as const
const originalKnown = models.known
const keyNames = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'SERPER_API_KEY'] as const
const savedKeys = keyNames.map((key) => process.env[key])
let home = ''

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-questions-`)
	process.env.HAL_HOME = home
	for (let key of keyNames) delete process.env[key]
	liveFiles.onError = () => {}
	synthetic.models = { ...origModels }
	synthetic.pauseMs = () => 0
	clients.timezone = () => undefined
	clients.hostZone = () => 'UTC'
	models.known = () => ['anthropic/test-claude', 'openai/test-gpt', 'opencode-go/test-go']
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	config.reset()
	auth.close()
	synthetic.models = origModels
	synthetic.pauseMs = origPause
	;[clients.timezone, clients.hostZone] = origZones
	models.known = originalKnown
	liveFiles.onError = origOnError
	keyNames.forEach((key, i) => {
		if (savedKeys[i] === undefined) delete process.env[key]
		else process.env[key] = savedKeys[i]
	})
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

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
	expect(a.views.get(id)!.state).toEqual({ type: 'blocked', reason: 'question' })
	expect(a.of('turn-end')).toEqual([])
	// A message sent meanwhile waits in the inbox; the question stays open.
	a.conn.send({ type: 'submit', sessionId: id, text: 'hello?' })
	expect(a.views.get(id)!.inbox.map((m) => m.text)).toEqual(['hello?'])
	expect(transcript.question((await opened(id)).views.get(id))?.id).toBe(q.id)

	b.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { name: 'Dave' } })
	a.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { name: 'Eve' } })
	expect(a.of('rejected').at(-1)).toMatchObject({ command: 'answer', reason: expect.stringMatching(/not open/) })
	await until(() => transcript.question(a.views.get(id))?.form.fields[0]?.name === 'language')
	let view = a.views.get(id)!
	expect(view.state).toEqual({ type: 'blocked', reason: 'question' })
	expect(texts(view)[1]).toContain('Dave')
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
	await until(() => transcript.question(b.views.get(id))?.form.fields[0]?.name === 'language')
})

test('Escape while a question waits pauses the turn; continuing asks again', async () => {
	synthetic.models.asker = () => ({ ask: { text: 'Name?', fields: [{ type: 'text', name: 'name' }] } })
	let a = client()
	let id = created(a, 'hal/asker')
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

const field = (c: ReturnType<typeof client>, id: string) => transcript.question(c.views.get(id))?.form.fields[0]

async function reply(c: ReturnType<typeof client>, id: string, name: string, value: string, next?: string) {
	await until(() => field(c, id)?.name === name)
	c.conn.send({ type: 'answer', sessionId: id, question: transcript.question(c.views.get(id))!.id, answers: { [name]: value } })
	if (next) await until(() => field(c, id)?.name === next)
}

test('intro resumes through profile, timezone, save, model and secret search setup', async () => {
	clients.timezone = () => 'Europe/Helsinki'
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'hello' })
	await reply(c, id, 'name', 'Rowan', 'language')
	expect(texts(c.views.get(id)!)[0]).toBe('Hello — I am HAL 9001, your personal agent harness. You can call me Hal.\n\nI have four questions for you.')
	// A restart between steps keeps answers in history.
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	c = await opened(id)
	await reply(c, id, 'language', 'US English', 'timezone')
	// The device and the host disagree: ask, naming the city.
	expect(transcript.question(c.views.get(id))!.form.text).toBe('It seems like you are in the Helsinki timezone (Europe/Helsinki). Correct?')
	process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
	// An environment key alone still gets the sign-in offer.
	await reply(c, id, 'timezone', 'Yes', 'login')
	await reply(c, id, 'login', 'Skip', 'model')
	expect(readFileSync(`${home}/USER.md`, 'utf8')).toBe('# User\n\nName: Rowan\n\nLanguage preference: US English\n\nTimezone: Europe/Helsinki\n')
	expect(texts(c.views.get(id)!).join('\n')).toContain(`I saved your answers to ${home}/USER.md.`)
	let options = (field(c, id) as { options: string[] }).options
	// Friendly names of the aliases a credential can use, never ids.
	expect(options).toHaveLength(2)
	expect(options.join()).not.toContain('/')
	await reply(c, id, 'model', options[0]!, 'search')
	await reply(c, id, 'search', 'Yes', 'key')
	await reply(c, id, 'key', 'secret-SERPER-123')
	await until(() => c.of('turn-end').length > 0)
	expect(apiKeys.get('serper')).toBe('secret-SERPER-123')
	expect(statSync(paths.authFile()).mode & 0o777).toBe(0o600)
	expect(readFileSync(history.file(id), 'utf8')).not.toContain('secret-SERPER-123')
	expect(JSON.stringify(c.events)).not.toContain('secret-SERPER-123')
	expect(sessions.open(id).model).toStartWith('anthropic/')
	expect(readFileSync(paths.configFile(), 'utf8')).toContain(sessions.open(id).model)
})

test('with no credential the intro offers /login, pauses for it and goes on once signed in', async () => {
	apiKeys.save('serper', 'existing-key')
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'start' })
	expect(texts(await (async () => { await until(() => field(c, id)); return c.views.get(id)! })())[0]).toContain('three questions')
	await reply(c, id, 'name', '', 'language')
	await reply(c, id, 'language', '', 'login')
	// Nothing answered, nothing saved.
	expect(profile.text()).toBe('')
	await reply(c, id, 'login', '/login opencode', 'key')
	expect(c.views.get(id)!.state.type).toBe('paused')
	expect(c.of('command').at(-1)?.text).toBe('/login opencode')
	await reply(c, id, 'key', 'test-key')
	await until(() => c.of('turn-end').some((e) => e.status === 'completed'))
	expect(apiKeys.get('opencode-go')).toBe('test-key')
	// No alias target runs on OpenCode Go: no model question, a pointer instead.
	expect(texts(c.views.get(id)!).at(-1)).toContain('/model or Ctrl-M')
	expect(sessions.open(id).model).toBe('hal/intro')
})

test('the Serper key step never traps: an empty key or Escape moves on', async () => {
	for (let escape of [false, true]) {
		let c = client(), id = created(c)
		c.conn.send({ type: 'submit', sessionId: id, text: 'start' })
		await reply(c, id, 'name', '', 'language')
		await reply(c, id, 'language', '', 'login')
		await reply(c, id, 'login', 'Skip', 'search')
		await reply(c, id, 'search', 'Yes', 'key')
		if (escape) c.conn.send({ type: 'pause', sessionId: id })
		else await reply(c, id, 'key', '  ')
		await until(() => c.of('turn-end').some((e) => e.status === 'completed'))
		expect(texts(c.views.get(id)!).join('\n')).toContain('Skipped web search')
		// Login was skipped: the close points to /login.
		expect(texts(c.views.get(id)!).at(-1)).toContain('/login')
		expect(apiKeys.get('serper')).toBeUndefined()
	}
})

test('the timezone is saved unasked only when device and host agree on a real zone', () => {
	let run: HistoryRecord[] = []
	let ts = new Date().toISOString()
	let answer = (name: string, value: string, text = '') => {
		run.push({ type: 'question', id: name, form: { text, fields: [{ type: 'text', name }] }, ts }, { type: 'answer', question: name, answers: { [name]: value }, ts })
		return intro.timezone(run, 's')
	}
	let zones = (device: string | undefined, host: string) => {
		clients.timezone = () => device
		clients.hostZone = () => host
		run = []
		return intro.timezone(run, 's')
	}
	expect(zones('Europe/Helsinki', 'Europe/Helsinki')).toEqual({ zone: 'Europe/Helsinki' })
	expect(zones(undefined, 'Etc/UTC')).toEqual({})
	expect(zones(undefined, 'Europe/Paris').ask?.ask?.text).toContain('(Europe/Paris)')
	expect(zones('UTC', 'UTC').ask?.ask?.fields[0]?.name).toBe('timezone')
	let asked = zones('Europe/Helsinki', 'UTC').ask!.ask!
	expect(answer('timezone', 'Yes', asked.text)).toEqual({ zone: 'Europe/Helsinki' })
	run = []
	let pick = answer('timezone', 'No', asked.text).ask!.ask!.fields[0] as { options: string[] }
	expect(pick.options).toEqual(['This device (Europe/Helsinki)', 'The server (UTC)', 'Other'])
	expect(answer('zone', 'The server (UTC)')).toEqual({ zone: 'UTC' })
	answer('zone', 'Other')
	let retry = answer('city', 'Atlantis').ask!
	expect(retry.say).toContain('Atlantis')
	expect(answer('city', 'new york')).toEqual({ zone: 'America/New_York' })
	expect(answer('city', 'kolkata')).toEqual({ zone: 'Asia/Kolkata' })
	expect(answer('city', '')).toEqual({})
})

test('text typed outside a question asks whether to go on; No ends the intro', () => {
	let ts = new Date().toISOString()
	let records: HistoryRecord[] = [
		{ type: 'user', blocks: [{ type: 'text', text: 'hi' }], ts },
		{ type: 'assistant', block: { type: 'text', text: 'Hello — I am HAL 9001, your personal agent harness. You can call me Hal.' }, ts },
		{ type: 'user', blocks: [{ type: 'text', text: 'open the pod bay doors' }], ts },
	]
	let first = intro.run(records)
	expect(first.say).toBe('I see you typed: "open the pod bay doors" — but I\'m not a language model, so I can\'t understand you.')
	expect(first.ask?.fields[0]?.name).toBe('intro')
	expect(intro.run([...records, { type: 'answer', question: 'q', answers: { intro: 'Yes' }, ts }]).ask?.fields[0]?.name).toBe('name')
	let no = intro.run([...records, { type: 'answer', question: 'q', answers: { intro: 'No' }, ts }])
	expect(no.ask).toBeUndefined()
})

test('saving the profile rewrites only its fields and keeps everything else byte for byte', () => {
	let original = '# User\nFreeform notes, kept verbatim.\nName: <name>\n\n## Working preferences\n\nLikes quiet rooms.\nName: stale'
	writeFileSync(`${home}/USER.md`, original)
	profile.save({ Name: 'Rowan', 'Language preference': '', Timezone: 'Europe/Paris' })
	expect(readFileSync(`${home}/USER.md`, 'utf8')).toBe('# User\nFreeform notes, kept verbatim.\nName: Rowan\n\nTimezone: Europe/Paris\n\n## Working preferences\n\nLikes quiet rooms.')
	expect(statSync(`${home}/USER.md`).mode & 0o777).toBe(0o600)
})
