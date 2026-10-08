import { expect, test } from 'bun:test'
import { calls, client, created, fresh, records, restartHost, shown, until, useHost } from './host-fixture.test.ts'
import { contextTransitions } from './context-transitions.ts'
import { history } from './history.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'
import { titles } from '../common/titles.ts'
import { amend } from '../common/amend.ts'
import { busy } from './busy.ts'
import { pages } from './pages.ts'
import { tabs } from './tabs.ts'
import { prompts } from './prompts.ts'

useHost()
const commandCall = (command: string, id = 'reset') => ({ type: 'tool_call' as const, id, name: 'command', input: { command } })

test('self-issued clear records results for later undispatched calls, ends old turn and starts attributed literal multiline continuation', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'old prompt' })
	await until(() => calls.length === 1)
	let tail = '/rename literal, not a command\n  "quoted" @file\n'
	calls[0]!.push(commandCall(`/clear ${tail}`), commandCall('/rename concurrent', 'later'), { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	let all = await records(id)
	let boundary = all.findIndex((r) => r.type === 'reset')
	expect(all.slice(0, boundary).find((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'tool_result' && b.id === 'later' && b.isError))).toBeDefined()
	expect(all.slice(0, boundary).at(-1)?.type).toBe('turn_end')
	let prompt = c.views.get(id)!.items.find((i) => i.type === 'prompt')!
	expect(prompt).toMatchObject({ text: tail, origin: 'model', generatingCommand: 'clear' })
	expect(titles.author(prompt)).toBe('Hal (/clear continuation)')
	expect(amend.begin(c.views.get(id), '')).toBeUndefined()
	expect(JSON.stringify(calls[1]!.input.messages)).toContain('; Hal; /clear continuation]')
	expect(JSON.stringify(calls[1]!.input.messages)).not.toContain('old prompt')
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length === 2)
	expect(shown((await fresh(id)).items)).toEqual(shown(c.views.get(id)!.items))
})

test('self-issued compact waits for every tool result, preserves prompt and continues same turn', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'active prompt' })
	await until(() => calls.length === 1)
	calls[0]!.push(commandCall('/compact'), commandCall('/rename Later tool', 'later'), { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	let all = await records(id), boundary = all.findIndex((r) => r.type === 'compact')
	expect(all[boundary - 1]).toMatchObject({ type: 'user', blocks: [{ type: 'tool_result', id: 'reset' }, { type: 'tool_result', id: 'later' }] })
	expect(JSON.stringify(calls[1]!.input.messages)).toContain('active prompt')
	expect(c.of('turn-end').length).toBe(0)
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length === 1)
})

test('human clear cancels streaming, ends before the boundary, and an empty context still starts a supplied prompt', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: '/clear fresh' })
	await until(() => calls.length === 1)
	expect(c.views.get(id)!.items.find((i) => i.type === 'prompt')).toMatchObject({ text: 'fresh', generatingCommand: 'clear' })
	c.conn.send({ type: 'submit', sessionId: id, text: '/clear' })
	await until(() => c.of('turn-end').length === 1)
	expect(calls.length).toBe(1)
	expect((await records(id)).findLast((r) => r.type === 'turn_end')).toMatchObject({ status: 'completed' })
	expect(shown((await fresh(id)).items)).toEqual(shown(c.views.get(id)!.items))
})

test('human clear lets foreground work settle; Escape cancels continuation and conflicts cannot overwrite it', async () => {
	let c = client(), id = created(c), resolve!: () => void
	let original = tools.run
	tools.run = async (call, ctx) => call.name === 'held' ? (await new Promise<void>((r) => resolve = r), { type: 'tool_result', id: call.id, output: 'settled' }) : original(call, ctx)
	try {
		c.conn.send({ type: 'submit', sessionId: id, text: 'work' })
		await until(() => calls.length === 1)
		calls[0]!.push({ type: 'tool_call', id: 'held', name: 'held', input: {} }, commandCall('/rename concurrent', 'later'), { type: 'done', reason: 'tool_use' })
		await until(() => !!resolve)
		c.conn.send({ type: 'submit', sessionId: id, text: '/clear automatic' })
		expect(turns.state.running.get(id)!.controller.signal.aborted).toBe(false)
		c.conn.send({ type: 'submit', sessionId: id, text: '/clear conflict' })
		await until(() => c.of('output').some((o) => o.error))
		expect(contextTransitions.pending(id)?.prompt).toBe('automatic')
		c.conn.send({ type: 'pause', sessionId: id })
		resolve()
		await until(() => c.of('turn-end').length === 1)
		expect(calls.length).toBe(1)
		expect(c.views.get(id)!.state.type).toBe('paused')
		expect(contextTransitions.pending(id)).toBeUndefined()
		expect((await records(id)).findLast((r) => r.type === 'user')).toMatchObject({ blocks: [{ type: 'tool_result', id: 'held', output: 'settled' }, { type: 'tool_result', id: 'later', output: expect.stringContaining('concurrent') }] })
	} finally { tools.run = original }
})

test('closed-tab recovery retains accepted intent across boundary and prompt crash gaps without duplicate injection', async () => {
	for (let gap of ['intent', 'boundary', 'prompt', 'done'] as const) {
		let c = client(), id = created(c)
		let intent = { id: `intent-${gap}`, kind: 'clear' as const, prompt: 'durable continuation', sender: { origin: 'model' as const } }
		history.append(id, { type: 'output', text: 'accepted', transition: intent })
		if (gap !== 'intent') history.append(id, { type: 'reset', transition: intent.id })
		if (gap === 'prompt' || gap === 'done') history.submit(id, [{ type: 'text', text: intent.prompt, origin: 'model', generatingCommand: 'clear' }], intent.id)
		if (gap === 'done') history.append(id, { type: 'output', text: 'applied', transitionDone: intent.id })
		expect(busy.list()).toContain(id)
		if (gap !== 'done') expect(pages.essentials(id).some((r) => r.type === 'output' && r.transition)).toBe(true)
		tabs.file().open = []
		restartHost()
		let before = calls.length
		await turns.recover()
		await until(() => calls.length === before + 1)
		expect((await records(id)).filter((r) => r.type === 'user' && r.command === intent.id).length).toBe(1)
		expect((await records(id)).filter((r) => r.type === 'reset' && r.transition === intent.id).length).toBe(1)
		calls.at(-1)!.push({ type: 'done', reason: 'end' })
		await until(() => !turns.state.running.has(id))
	}
})

test('cross-session clear inherits host sender through execution and fresh prompt framing', async () => {
	let c = client(), id = created(c)
	prompts.submit(id, '/clear forwarded', undefined, 'steer', { from: '02-abc', label: 'tab 2 · Other session' })
	await until(() => calls.length === 1)
	let prompt = c.views.get(id)!.items.find((i) => i.type === 'prompt')!
	expect(titles.author(prompt)).toBe('Message from tab 2 · Other session (/clear continuation)')
	expect(JSON.stringify(calls[0]!.input.messages)).toContain('; message from tab 2 (Other session); /clear continuation]')
	expect(titles.author({ type: 'command', text: '/clear', from: '02-abc' })).toBe('Command from 02-abc')
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length === 1)
	expect(shown((await fresh(id)).items)).toEqual(shown(c.views.get(id)!.items))
})

test('bare clear ends paused and failed contexts idle, both live and after reload', async () => {
	for (let failure of [false, true]) {
		let c = client(), id = created(c), before = calls.length
		c.conn.send({ type: 'submit', sessionId: id, text: 'work' })
		await until(() => calls.length === before + 1)
		if (failure) calls.at(-1)!.push({ type: 'error', message: 'failure' })
		else c.conn.send({ type: 'pause', sessionId: id })
		await until(() => c.of('turn-end').length === 1)
		c.conn.send({ type: 'submit', sessionId: id, text: '/clear' })
		await until(() => c.of('divider').length === 1)
		expect(c.views.get(id)!.state.type).toBe('idle')
		expect((await fresh(id)).state.type).toBe('idle')
		expect(calls.length).toBe(before + 1)
	}
})

test('recovery settles orphaned calls before clear turn end and keeps canceled continuation paused', async () => {
	let c = client(), id = created(c)
	history.submit(id, 'unfinished')
	history.append(id, { type: 'assistant', block: commandCall('/clear followup') })
	let intent = { id: 'canceled-intent', kind: 'clear' as const, prompt: 'must not start', sender: { origin: 'model' as const } }
	history.append(id, { type: 'output', text: 'accepted', transition: intent })
	history.append(id, { type: 'output', text: 'canceled', transitionCancel: intent.id })
	restartHost()
	await turns.recover()
	let all = await records(id), end = all.findIndex((r) => r.type === 'turn_end'), results = all.findIndex((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'tool_result'))
	expect(results).toBeLessThan(end)
	expect((await fresh(id)).state.type).toBe('paused')
	expect(calls.length).toBe(0)
	await turns.recover()
	expect(calls.length).toBe(0)
})

test('clear at a parked approval closes the old turn and held calls never resume', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'dangerous work' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'tool_call', id: 'danger', name: 'bash', input: { command: 'rm -rf /reserved-example', description: 'Requires approval', modifies: [] } }, { type: 'done', reason: 'tool_use' })
	await until(() => c.of('question').length === 1)
	let question = c.of('question')[0]!.id
	c.conn.send({ type: 'submit', sessionId: id, text: '/clear' })
	await until(() => c.of('divider').length === 1)
	expect(c.views.get(id)!.state.type).toBe('idle')
	expect((await fresh(id)).state.type).toBe('idle')
	c.conn.send({ type: 'answer', sessionId: id, question, answers: { run: 'yes' } })
	await until(() => c.of('rejected').length === 1)
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(1)
	let all = await records(id), end = all.findIndex((r) => r.type === 'turn_end'), results = all.findIndex((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'tool_result'))
	expect(results).toBeLessThan(end)
})

test('human clear starts its continuation only after the round\'s calls settle', async () => {
	let c = client(), id = created(c), resolve!: () => void
	let original = tools.run
	tools.run = async (call, ctx) => call.name === 'held' ? (await new Promise<void>((r) => resolve = r), { type: 'tool_result', id: call.id, output: 'settled' }) : original(call, ctx)
	try {
		c.conn.send({ type: 'submit', sessionId: id, text: 'work' })
		await until(() => calls.length === 1)
		calls[0]!.push({ type: 'tool_call', id: 'held', name: 'held', input: {} }, commandCall('/rename concurrent', 'later'), { type: 'done', reason: 'tool_use' })
		await until(() => !!resolve)
		c.conn.send({ type: 'submit', sessionId: id, text: '/clear next' })
		expect(c.of('divider').length).toBe(0)
		expect(calls.length).toBe(1)
		resolve()
		await until(() => calls.length === 2)
		expect(c.of('turn-end').length).toBe(1)
		expect(c.views.get(id)!.items.find((i) => i.type === 'prompt')).toMatchObject({ text: 'next', generatingCommand: 'clear' })
		let all = await records(id), end = all.findIndex((r) => r.type === 'turn_end')
		expect(all[end - 1]).toMatchObject({ type: 'user', blocks: [{ type: 'tool_result', id: 'held', output: 'settled' }, { type: 'tool_result', id: 'later', output: expect.stringContaining('concurrent') }] })
		calls[1]!.push({ type: 'done', reason: 'end' })
		await until(() => c.of('turn-end').length === 2)
	} finally { tools.run = original }
})

test('Escape cancels pending compact without restarting its paused turn after recovery', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'work' })
	await until(() => calls.length === 1)
	c.conn.send({ type: 'submit', sessionId: id, text: '/compact' })
	c.conn.send({ type: 'pause', sessionId: id })
	await until(() => c.of('turn-end').length === 1)
	expect(c.of('divider').length).toBe(0)
	expect(contextTransitions.pending(id)).toBeUndefined()
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(1)
	expect((await fresh(id)).state.type).toBe('paused')
})
