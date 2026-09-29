import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { ason } from '../../common/ason.ts'
import { forms } from '../../common/forms.ts'
import { settings } from '../../common/settings.ts'
import { config } from '../config.ts'
import { client, created, testHome, until, useHost } from '../host-fixture.test.ts'
import { history } from '../history.ts'
import { prompts } from '../prompts.ts'

useHost()
beforeEach(() => config.init())
afterEach(() => config.reset())

async function open(c: ReturnType<typeof client>, id: string) {
	c.conn.send({ type: 'submit', sessionId: id, text: '/config' })
	await until(() => c.of('question').length)
	return c.of('question').at(-1) as { id: string; form: Parameters<typeof forms.start>[1] }
}

test('the form prefills settings; invalid submissions stay open and write nothing; valid ones preserve other keys', async () => {
	config.state.data!.extra = 'kept'
	config.state.data!.model = 'test/first'
	let c = client(), id = created(c)
	let q = await open(c, id)
	let state = forms.start(q.id, q.form)
	let answers = forms.answers(state)
	expect(answers.model).toBe('test/first')
	expect(q.form.fields.find((f) => f.name === 'webPort')?.type).toBe('integer')
	answers.webPort = '1.5'
	answers.model = 'test/second'
	expect(prompts.reply(id, q.id, answers)).toContain('webPort: expected an integer')
	expect(forms.open(history.readSync(id))?.id).toBe(q.id)
	expect(settings.model()).toBe('test/first')
	expect(history.readSync(id).some((r) => r.type === 'answer')).toBe(false)
	answers.webPort = '4321'
	expect(prompts.reply(id, q.id, answers)).toBeUndefined()
	await until(() => c.of('output').length)
	let saved = ason.parse(readFileSync(`${testHome()}/config.ason`, 'utf8'))
	expect(saved).toEqual({ extra: 'kept', model: 'test/second', webPort: 4321 })
	// The second answer loses, even before the asynchronous command reply.
	expect(prompts.reply(id, q.id, answers)).toContain('not open')
})

test('unchanged fields do not clobber intervening edits; defaults are removed on change', async () => {
	config.update({ webPort: 4321 })
	let c = client(), id = created(c)
	let q = await open(c, id)
	let answers = forms.answers(forms.start(q.id, q.form))
	config.update({ model: 'test/external' })
	answers.webPort = String(settings.table.find((s) => s.name === 'webPort')!.default)
	expect(prompts.reply(id, q.id, answers)).toBeUndefined()
	await until(() => c.of('output').length)
	expect(config.state.data).toEqual({ model: 'test/external' })
})

test('secret settings never reach history, output, or warnings, through forms or direct sets', async () => {
	settings.table.push({ name: 'testSecret', type: { kind: 'secret' }, default: 'default-secret', description: 'Test credential.' })
	try {
		config.update({ testSecret: 'old-secret' })
		let c = client(), id = created(c)
		let q = await open(c, id)
		let answers = forms.answers(forms.start(q.id, q.form))
		expect(answers.testSecret).toBe('')
		answers.testSecret = 'form-secret'
		expect(prompts.reply(id, q.id, answers)).toBeUndefined()
		await until(() => c.of('output').length)
		c.conn.send({ type: 'submit', sessionId: id, text: '/config testSecret direct-secret' })
		await until(() => c.of('output').length === 2)
		expect(settings.value('testSecret')).toBe('direct-secret')
		let stored = JSON.stringify(history.readSync(id))
		let events = JSON.stringify(c.events)
		for (let secret of ['old-secret', 'form-secret', 'direct-secret', 'default-secret']) {
			expect(stored).not.toContain(secret)
			expect(events).not.toContain(secret)
		}
		config.state.data!.testSecret = { secret: 'bad-secret' }
		expect(settings.warnings().join('')).not.toContain('bad-secret')
	} finally {
		settings.table.pop()
	}
})

test('direct commands validate values, and a malformed config is never overwritten', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: '/config push false' })
	await until(() => c.of('output').length)
	expect(settings.push()).toBe(false)
	c.conn.send({ type: 'submit', sessionId: id, text: '/config webPort nope' })
	await until(() => c.of('output').length === 2)
	expect(c.of('output').at(-1).error).toBe(true)
	config.reset()
	writeFileSync(`${testHome()}/config.ason`, '{ broken')
	config.init()
	c.conn.send({ type: 'submit', sessionId: id, text: '/config model test/next' })
	await until(() => c.of('output').length === 3)
	expect(readFileSync(`${testHome()}/config.ason`, 'utf8')).toBe('{ broken')
	expect(config.state.data).toEqual({})
})
