// The hal/sync review session on the host (task b81): each /sync
// replaces the client home's review tab with a fresh session, relays
// turns to that terminal, and Escape asks it nothing.
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
const ask = {
	text: 'theme.ts: which version should both homes keep?',
	fields: [
		{
			type: 'choice' as const,
			name: 'choice',
			options: ['Use client version', 'Use server version', 'Keep separate — ignore sync for theme.ts on this client'],
			initial: 0,
		},
	],
}

test('/sync opens a fresh review tab each time, relays answers, and Escape asks nothing', async () => {
	mkdirSync(join(testHome(), 'plugins'))
	pluginHistory.init(join(testHome(), 'plugins'))
	let a = client()
	let first = created(a)
	let local = client()
	let other = created(local)
	local.conn.send({ type: 'submit', sessionId: other, text: '/sync' })
	await until(() => local.of('output').some((e: any) => e.text?.includes('hal -r')))
	expect(local.of('output').some((e: any) => e.error)).toBe(false)

	a.conn.send({ type: 'sync', op: 'inventory', home, names: [], id: 'inv' })
	a.conn.send({ type: 'submit', sessionId: first, text: '/sync' })
	await until(() => a.of('sync').some((e: any) => e.review))
	let old = a.of('sync').find((e: any) => e.review).review
	expect(a.of('go').at(-1)).toMatchObject({ sessionId: first, tab: old })
	expect(sessions.open(old)).toMatchObject({ model: 'hal/sync', name: `Sync ${home.slice(0, 6)}` })
	a.conn.send({ type: 'open', sessionId: old })
	a.conn.send({ type: 'sync', op: 'step', session: old, say: 'theme.ts differs.', ask, id: 's1' })
	await until(() => a.of('question').length === 1)

	// A repeat replaces the tab with a fresh session that asks afresh.
	let open = tabs.file().open.length
	a.conn.send({ type: 'submit', sessionId: first, text: '/sync' })
	await until(() => a.of('sync').filter((e: any) => e.review).length === 2)
	let review = a.of('sync').at(-1).review
	expect(review).not.toBe(old)
	expect(a.of('go').at(-1).tab).toBe(review)
	expect(tabs.file().open.length).toBe(open)
	expect(tabs.file().open.filter((id) => sessions.open(id).model === 'hal/sync')).toEqual([review])
	a.conn.send({ type: 'open', sessionId: review })

	// Escape defers: the turn pauses and the terminal hears nothing.
	a.conn.send({ type: 'sync', op: 'step', session: review, say: 'theme.ts differs.', ask, id: 's2' })
	await until(() => status.stateOf(review).type === 'blocked')
	a.conn.send({ type: 'pause', sessionId: review })
	await until(() => status.stateOf(review).type === 'paused')
	await Bun.sleep(20)
	expect(a.of('sync').filter((e: any) => e.review)).toHaveLength(2)

	// An answer reaches the terminal.
	a.conn.send({ type: 'submit', sessionId: first, text: '/sync' })
	await until(() => a.of('sync').filter((e: any) => e.review).length === 3)
	review = a.of('sync').at(-1).review
	expect(a.of('sync').at(-1).answers).toBeUndefined()
	a.conn.send({ type: 'open', sessionId: review })
	a.conn.send({ type: 'sync', op: 'step', session: review, say: 'theme.ts differs.', ask, id: 's3' })
	await until(() => a.of('question').some((q: any) => q.sessionId === review))
	a.conn.send({
		type: 'answer',
		sessionId: review,
		question: a.of('question').at(-1).id,
		answers: { choice: 'Use client version' },
	})
	await until(() => a.of('sync').filter((e: any) => e.review).length === 4)
	expect(a.of('sync').at(-1).answers).toEqual({ choice: 'Use client version' })
	a.conn.send({
		type: 'sync',
		op: 'step',
		session: review,
		say: 'Used the client version of theme.ts.',
		id: 's4',
	})
	await until(() => status.stateOf(review).type === 'idle')
	expect(tabs.file().open.filter((id) => sessions.open(id).model === 'hal/sync')).toEqual([review])
	pluginHistory.state = {
		dir: undefined,
		personal: undefined,
		home: new Map(),
		watchers: [],
		error: undefined,
		versions: new Map(),
		heads: new Map(),
	}
})
