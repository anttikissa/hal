import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { ason } from '../../common/ason.ts'
import { settings } from '../../common/settings.ts'
import { config } from '../config.ts'
import { client, created, testHome, until, useHost } from '../host-fixture.test.ts'
import { history } from '../history.ts'
import { warnings } from '../warnings.ts'

useHost()
// As main.ts wires it: every change reaches the clients.
beforeEach(() => config.init(() => warnings.all()))
afterEach(() => config.reset())

test('bare /config opens the modal with values and what config.ason holds; a change refreshes it', async () => {
	config.state.data!.extra = 'kept'
	config.state.data!.push = false
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: '/config' })
	await until(() => c.of('settings').length)
	let opened = c.of('settings')[0]
	expect(opened.sessionId).toBe(id)
	expect(opened.values.push).toBe('false')
	expect(opened.stored).toEqual({ push: 'push: false' })
	expect(history.readSync(id).some((r) => r.type === 'question')).toBe(false)
	c.conn.send({ type: 'submit', sessionId: id, text: '/config webPort 4321' })
	await until(() => c.of('settings').length === 2)
	expect(c.of('settings')[1]).toMatchObject({ refresh: true, stored: { push: 'push: false', webPort: 'webPort: 4321' } })
	// The file points to /config; other keys and the user's comments stay.
	let text = readFileSync(`${testHome()}/config.ason`, 'utf8')
	expect(text).toStartWith('{\n\t// Every setting, its default and meaning: /config\n')
	expect(ason.parse(text)).toEqual({ extra: 'kept', push: false, webPort: 4321 })
	c.conn.send({ type: 'submit', sessionId: id, text: '/config push true' })
	await until(() => c.of('settings').length === 3)
	text = readFileSync(`${testHome()}/config.ason`, 'utf8')
	expect(text.match(/\/config/g)?.length).toBe(1)
	expect(ason.parse(text)).toEqual({ extra: 'kept', webPort: 4321 })
})

test('secret settings never reach history, output, events, or warnings', async () => {
	settings.table.push({ name: 'testSecret', label: 'Test secret', type: { kind: 'secret' }, default: 'default-secret', description: 'Test credential.' })
	try {
		config.update({ testSecret: 'old-secret' })
		let c = client(), id = created(c)
		c.conn.send({ type: 'submit', sessionId: id, text: '/config' })
		await until(() => c.of('settings').length)
		expect(c.of('settings')[0]).toMatchObject({ values: { testSecret: 'set' }, stored: { testSecret: 'testSecret: (hidden)' } })
		c.conn.send({ type: 'submit', sessionId: id, text: '/config testSecret direct-secret' })
		await until(() => c.of('output').length)
		expect(settings.value('testSecret')).toBe('direct-secret')
		let stored = JSON.stringify(history.readSync(id))
		let events = JSON.stringify(c.events)
		for (let secret of ['old-secret', 'direct-secret', 'default-secret']) {
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
