// The hal/plugin-sync review session on the host (task b81): /plugin-sync
// opens one review tab per client home, relays turns to that terminal,
// and Escape or a repeat never makes it ask the terminal twice.
import { expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { client, created, testHome, until, useHost } from './host-fixture.test.ts'
import { pluginHistory } from './plugin-history.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'

useHost()

const home = 'f'.repeat(16)
const ask = { text: 'theme.ts: which version should both homes keep?', fields: [{ type: 'choice' as const, name: 'choice', options: ['Use client version', 'Use server version', 'Keep separate — ignore sync for theme.ts on this client'], initial: 0 }] }

test('/plugin-sync focuses one review tab, relays answers, and Escape asks nothing', async () => {
	mkdirSync(join(testHome(), 'plugins'))
	pluginHistory.init(join(testHome(), 'plugins'))
	let a = client()
	let first = created(a)
	let local = client()
	let other = created(local)
	local.conn.send({ type: 'submit', sessionId: other, text: '/plugin-sync' })
	await until(() => local.of('output').some((e: any) => e.error))
	expect(local.of('output').find((e: any) => e.error).text).toContain('./run -r')

	a.conn.send({ type: 'plugin-sync', op: 'inventory', home, names: [], id: 'inv' })
	a.conn.send({ type: 'submit', sessionId: first, text: '/plugin-sync' })
	await until(() => a.of('plugin-sync').some((e: any) => e.review))
	let review = a.of('plugin-sync').find((e: any) => e.review).review
	expect(a.of('go').at(-1)).toMatchObject({ sessionId: first, tab: review })
	expect(sessions.open(review)).toMatchObject({ model: 'hal/plugin-sync', name: `Plugin sync ${home.slice(0, 6)}` })
	a.conn.send({ type: 'open', sessionId: review })
	a.conn.send({ type: 'plugin-sync', op: 'step', session: review, say: 'theme.ts differs.', ask, id: 's1' })
	await until(() => a.of('question').length === 1)
	expect(status.stateOf(review).type).toBe('blocked')

	// A repeat focuses the same tab and asks the terminal nothing new.
	let open = tabs.file().open.length
	a.conn.send({ type: 'submit', sessionId: first, text: '/plugin-sync' })
	await until(() => a.of('go').length === 2)
	expect(a.of('go').at(-1).tab).toBe(review)
	expect(tabs.file().open.length).toBe(open)
	expect(a.of('plugin-sync').filter((e: any) => e.review)).toHaveLength(1)

	// Escape defers: the turn pauses and the terminal hears nothing.
	a.conn.send({ type: 'pause', sessionId: review })
	await until(() => status.stateOf(review).type === 'paused')
	await Bun.sleep(20)
	expect(a.of('plugin-sync').filter((e: any) => e.review)).toHaveLength(1)

	// Reopening asks afresh; an answer reaches the terminal.
	a.conn.send({ type: 'submit', sessionId: first, text: '/plugin-sync' })
	await until(() => a.of('plugin-sync').filter((e: any) => e.review).length === 2)
	expect(a.of('plugin-sync').at(-1).answers).toBeUndefined()
	a.conn.send({ type: 'plugin-sync', op: 'step', session: review, say: 'theme.ts differs.', ask, id: 's2' })
	await until(() => a.of('question').length === 2)
	a.conn.send({ type: 'answer', sessionId: review, question: a.of('question')[1].id, answers: { choice: 'Use client version' } })
	await until(() => a.of('plugin-sync').filter((e: any) => e.review).length === 3)
	expect(a.of('plugin-sync').at(-1).answers).toEqual({ choice: 'Use client version' })
	a.conn.send({ type: 'plugin-sync', op: 'step', session: review, say: 'Used the client version of theme.ts.', id: 's3' })
	await until(() => status.stateOf(review).type === 'idle')
	expect(tabs.file().open.filter((id) => sessions.open(id).model === 'hal/plugin-sync')).toEqual([review])
	pluginHistory.state = { dir: undefined, error: undefined, versions: new Map(), heads: new Map() }
})
