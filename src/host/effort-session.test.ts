import { expect, test } from 'bun:test'
import type { Item } from '../common/transcript.ts'
import { calls, client, created, fresh, restartHost, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { subagents } from './subagents.ts'
import { forks } from './forks.ts'
import { history } from './history.ts'

useHost()

test('effort persists, inherits on fresh spawn/fork, resets on own model and refuses invalid changes atomically', async () => {
	let c = client()
	let id = created(c)
	slash.change(id, { model: 'openai/gpt-6-sol:max' })
	expect(() => slash.change(id, { model: 'gpt:banana' })).toThrow('unknown effort')
	expect(sessions.open(id)).toMatchObject({ model: 'openai/gpt-6-sol', effort: 'max' })
	let base = { kind: 'interactive' as const, task: '', fork: false, cwd: '/tmp', limit: 0 }
	let inherited = subagents.spawn(id, base)
	let own = subagents.spawn(id, { ...base, model: 'openai/gpt-6.1-sol' })
	let fork = forks.create(id)
	expect(sessions.open(inherited).effort).toBe('max')
	expect(sessions.open(own).effort).toBeUndefined()
	expect(sessions.open(fork).effort).toBe('max')
	restartHost()
	expect(sessions.open(id).effort).toBe('max')
	expect((await fresh(id)).meta.effort).toBe('max')
	slash.change(id, { model: 'openai/gpt-6-sol:default' })
	expect(sessions.open(id).effort).toBeUndefined()
	expect(history.readSync(id).filter((r) => r.type === 'change').at(-1)).toMatchObject({ model: 'openai/gpt-6-sol' })
})

test('an effort change interrupts streaming while preserving each reply header, live and replay agree', async () => {
	let c = client()
	let id = created(c)
	slash.change(id, { model: 'openai/gpt-6-sol:low' })
	c.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => calls.length === 1)
	expect(calls[0]!.input.effort).toBe('low')
	calls[0]!.push({ type: 'thinking', text: 'before' })
	await until(() => c.views.get(id)?.items.some((i) => i.type === 'thinking'))
	slash.change(id, { model: 'openai/gpt-6-sol:max' })
	calls[0]!.push({ type: 'thinking', text: ' after' }, { type: 'tool_call', id: 'x', name: 'missing', input: {} }, { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.effort).toBe('max')
	expect(calls[1]!.input.messages.flatMap((m: any) => m.blocks).some((b: any) => b.type === 'tool_call' && b.id === 'x')).toBe(false)
	calls[1]!.push({ type: 'thinking', text: 'next' }, { type: 'text', text: 'ok' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)
	let headers = (items: Item[]) => items.filter((i) => i.type === 'thinking').map((i) => ({ text: i.text, model: i.model, effort: i.effort }))
	expect(headers(c.views.get(id)!.items)).toEqual([{ text: 'before', model: 'openai/gpt-6-sol', effort: 'low' }, { text: 'next', model: 'openai/gpt-6-sol', effort: 'max' }])
	expect(headers((await fresh(id)).items)).toEqual(headers(c.views.get(id)!.items))
})
