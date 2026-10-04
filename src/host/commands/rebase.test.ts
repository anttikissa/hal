import { expect, test } from 'bun:test'
import { client, created, fresh, restartHost, until, useHost, calls } from '../host-fixture.test.ts'
import { history } from '../history.ts'
import { tools } from '../tools.ts'

useHost()

test('rebase plans are requester-local; changes, dividers and undo reach every follower and survive restart', async () => {
	let a = client(), id = created(a), b = client()
	let prompt = history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'original prompt' }] })
	let answer = history.append(id, { type: 'assistant', block: { type: 'text', text: 'large answer' } })
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: '/rebase' })
	await until(() => a.of('rebase-plan').length)
	expect(b.of('rebase-plan')).toHaveLength(0)
	let start = a.of('rebase-plan')[0]
	a.conn.send({ type: 'rebase-apply', sessionId: id, base: start.snapshot.base, plan: { base: start.snapshot.base, drop: [answer.n], edit: [{ n: prompt.n, text: 'fixed prompt' }] } })
	expect(a.of('history-rewritten')).toHaveLength(1)
	expect(b.of('history-rewritten')).toHaveLength(1)
	for (let c of [a, b]) {
		expect(c.views.get(id)?.items.some((i) => i.type === 'text' && i.text === 'large answer')).toBe(false)
		expect(c.views.get(id)?.items.some((i) => i.type === 'prompt' && i.text === 'fixed prompt')).toBe(true)
		expect(c.views.get(id)?.items.find((i) => i.type === 'divider')).toMatchObject({ text: expect.stringContaining('1 dropped, 1 edited') })
	}
	restartHost()
	expect((await fresh(id)).items.some((i) => i.type === 'divider')).toBe(true)
	let c = client(); c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.views.has(id))
	c.conn.send({ type: 'submit', sessionId: id, text: '/rebase undo' })
	await until(() => c.of('history-rewritten').length)
	expect(c.views.get(id)?.items.some((i) => i.type === 'text' && i.text === 'large answer')).toBe(true)
	expect(c.views.get(id)?.items.some((i) => i.type === 'prompt' && i.text === 'original prompt')).toBe(true)
	expect(history.readSync(id).filter((r) => r.type === 'rebase')).toHaveLength(2)
})

test('stale and malformed plans never append a rebase; busy sessions refuse; model cannot invoke rebase', async () => {
	let a = client(), id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: '/rebase' })
	await until(() => a.of('rebase-plan').length)
	let start = a.of('rebase-plan')[0]
	a.conn.send({ type: 'submit', sessionId: id, text: '/rename Changed' })
	await until(() => a.of('meta').length)
	a.conn.send({ type: 'rebase-apply', sessionId: id, base: start.snapshot.base, todo: start.todo })
	expect(a.of('output').at(-1).text).toContain('stale')
	a.conn.send({ type: 'rebase-apply', sessionId: id, base: 'wrong', todo: start.todo })
	expect(a.of('rejected').at(-1).reason).toContain('base')
	expect(history.readSync(id).some((r) => r.type === 'rebase')).toBe(false)
	await expect(tools.all().get('command')!.run({ command: '/rebase' }, { sessionId: id, signal: new AbortController().signal } as any)).rejects.toThrow('not available to the model')
	a.conn.send({ type: 'submit', sessionId: id, text: 'running' })
	await until(() => calls.length)
	a.conn.send({ type: 'submit', sessionId: id, text: '/rebase' })
	await until(() => a.of('output').at(-1)?.error)
	expect(a.of('output').at(-1).text).toContain('Pause the session')
})

test('todo replacement text is applied; queue prompts start in order; empty and unchanged plans do not rewrite', async () => {
	let a = client(), id = created(a)
	let user = history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'original' }] })
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	a.conn.send({ type: 'submit', sessionId: id, text: '/rebase' })
	await until(() => a.of('rebase-plan').length)
	let start = a.of('rebase-plan')[0]
	a.conn.send({ type: 'rebase-apply', sessionId: id, base: start.snapshot.base, todo: start.todo })
	a.conn.send({ type: 'rebase-apply', sessionId: id, base: start.snapshot.base, todo: '' })
	expect(history.readSync(id).some((r) => r.type === 'rebase')).toBe(false)
	let todo = start.todo.replace(`keep  #${user.n}`, `edit  #${user.n}`) + 'queue first\nqueue second\n'
	a.conn.send({ type: 'rebase-apply', sessionId: id, base: start.snapshot.base, todo, replacements: { [user.n!]: 'edited' } })
	await until(() => calls.length === 1)
	expect(a.of('turn-start').at(-1).prompt).toBe('first')
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 2)
	expect(a.of('turn-start').at(-1).prompt).toBe('second')
})
