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
beforeEach(() => void (config.state.onChange = () => warnings.all()))
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
	expect(opened.stored).toEqual({ model: "model: 'anthropic/claude-opus-5-5'", push: 'push: false' })
	expect(history.readSync(id).some((r) => r.type === 'question')).toBe(false)
	c.conn.send({ type: 'submit', sessionId: id, text: '/config webPort 4321' })
	await until(() => c.of('settings').length === 2)
	expect(c.of('settings')[1]).toMatchObject({ refresh: true, stored: { push: 'push: false', webPort: 'webPort: 4321' } })
	// The file points to /config; other keys and the user's comments stay.
	let text = readFileSync(`${testHome()}/config.ason`, 'utf8')
	expect(text).toStartWith('{\n\t// Every setting, its default and meaning: /config\n')
	// A key /config writes carries its description and default.
	expect(text).toContain('\t// Preferred port for the browser client (127.0.0.1); tries through 9100\n\t// if busy. Default: 9001.\n\twebPort: 4321')
	expect(ason.parse(text)).toEqual({ model: 'anthropic/claude-opus-5-5', extra: 'kept', push: false, webPort: 4321 })
	c.conn.send({ type: 'submit', sessionId: id, text: '/config push true' })
	await until(() => c.of('settings').length === 3)
	text = readFileSync(`${testHome()}/config.ason`, 'utf8')
	expect(text.match(/\/config/g)?.length).toBe(1)
	expect(ason.parse(text)).toEqual({ model: 'anthropic/claude-opus-5-5', extra: 'kept', webPort: 4321 })
})

test('direct commands validate values, and a malformed config is never overwritten', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: '/config push false' })
	await until(() => settings.push() === false)
	c.conn.send({ type: 'submit', sessionId: id, text: '/config webPort nope' })
	await until(() => c.of('output').length === 1)
	expect(c.of('output').at(-1).error).toBe(true)
	config.reset()
	writeFileSync(`${testHome()}/config.ason`, '{ broken')
	config.init()
	c.conn.send({ type: 'submit', sessionId: id, text: '/config model test/next' })
	await until(() => c.of('output').length === 2)
	expect(readFileSync(`${testHome()}/config.ason`, 'utf8')).toBe('{ broken')
	expect(config.state.data).toEqual({})
})
