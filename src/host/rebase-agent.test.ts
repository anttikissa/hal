import { expect, test } from 'bun:test'
import { calls, client, created, records, restartHost, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { rebaseAgent } from './rebase-agent.ts'
import { rebasePlans } from './rebase-plans.ts'
import { rebaseRows } from '../common/rebase-rows.ts'
import { replay } from '../common/replay.ts'
import { turns } from './turns.ts'
import { tools } from './tools.ts'
import { rebaseSparse } from '../common/rebase-sparse.ts'
import { prompts } from './prompts.ts'
import { contextTransitions } from './context-transitions.ts'

useHost()
const command = (text: string, id = 'rebase') => ({ type: 'tool_call' as const, id, name: 'command', input: { command: text } })

test('self-rebase open tail removes its own exchange, keeps original prompt, and continues without replay', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'original prompt' })
	await until(() => calls.length === 1)
	rebaseAgent.show(id)
	let n = history.readSync(id).at(-1)!.n! + 1
	calls[0]!.push(command(`/rebase run drop ${n}-`), { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	let raw = await records(id), current = replay.current(history.readSync(id))
	expect(raw.some((r) => r.type === 'rebase')).toBe(true)
	expect(current.some((r) => r.type === 'assistant' && r.block.type === 'tool_call')).toBe(false)
	let messages = JSON.stringify(calls[1]!.input.messages)
	expect(messages).toContain('original prompt')
	expect(messages).not.toContain('/rebase')
	expect(messages).not.toContain('Rebase applied')
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => !turns.state.running.has(id))
})

test('self-removed paused rebase keeps a durable report with drop ranges and edited IDs', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'before' })
	await until(() => calls.length === 1)
	let n = history.readSync(id).find((r) => r.type === 'user')!.n!
	let tail = history.readSync(id).at(-1)!.n! + 1
	calls[0]!.push(command(`/rebase run --paused edit ${n} "after"; drop ${tail}-`), { type: 'done', reason: 'tool_use' })
	await until(() => !turns.state.running.has(id))
	let current = replay.current(await history.read(id))
	expect(current.some((r) => r.type === 'assistant' && r.block.type === 'tool_call')).toBe(false)
	let report = current.find((r) => r.type === 'output' && r.text.startsWith('Rebase applied ('))
	expect(report).toBeDefined()
	if (report?.type !== 'output') throw new Error('Missing surviving report')
	expect(report.text.split('\n')[0]).toMatch(/^Rebase applied \(dropped \d+ entr(y|ies), edited 1\)$/)
	expect(report.text).toContain(`Edited #${n}`)
	expect(report.text).toContain('--paused')
	expect(report.text).toContain(`#${tail}`)
	expect(report.text).toContain('-before')
	expect(report.text).toContain('+after')
	expect(calls).toHaveLength(1)
})

test('retained rebase call receives actual result and paused stops before another request', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'before' })
	await until(() => calls.length === 1)
	let n = history.readSync(id).find((r) => r.type === 'user')!.n
	calls[0]!.push(command(`/rebase run --paused edit ${n} "after"`), { type: 'done', reason: 'tool_use' })
	await until(() => c.of('turn-end').length === 1)
	expect(calls.length).toBe(1)
	expect(c.views.get(id)!.state.type).toBe('paused')
	let current = replay.current(history.readSync(id))
	expect(current.find((r) => r.type === 'user')).toMatchObject({ blocks: [{ text: 'after' }] })
	expect(current.findLast((r) => r.type === 'user')).toMatchObject({ blocks: [{ type: 'tool_result', output: expect.stringContaining('Rebase applied (') }] })
})

test('append activity is allowed after show, but intervening context rewrite refuses without dropping', async () => {
	let c = client(), id = created(c)
	history.submit(id, 'one')
	history.append(id, { type: 'assistant', block: { type: 'text', text: 'two' } })
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	rebaseAgent.show(id)
	history.append(id, { type: 'notice', text: 'ordinary append' })
	expect(rebaseAgent.request(id, 'drop 2', true, false)).toContain('Rebase preview')
	history.append(id, { type: 'reset' })
	expect(() => rebaseAgent.request(id, 'drop 2', false, false)).toThrow('stale')
	expect((await records(id)).some((r) => r.type === 'rebase')).toBe(false)
})

test('user sparse and editor rebase automatically continue trailing prompts, paused suppresses it', async () => {
	for (let editor of [false, true]) for (let paused of [false, true]) {
		let c = client(), id = created(c), before = calls.length
		history.submit(id, 'try again')
		history.append(id, { type: 'assistant', block: { type: 'text', text: 'remove me' } })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		let snapshot = rebaseRows.build(history.readSync(id)), target = snapshot.rows.find((r) => r.kind === 'assistant')!.n
		if (editor) rebasePlans.apply({ type: 'rebase-apply', id: 'apply', sessionId: id, base: snapshot.base, plan: { base: snapshot.base, drop: [target], edit: [] }, paused })
		else rebaseAgent.request(id, `drop ${target}`, false, paused)
		if (paused) { expect(calls.length).toBe(before); expect(turns.state.running.has(id)).toBe(false) }
		else {
			await until(() => calls.length === before + 1)
			expect(JSON.stringify(calls.at(-1)!.input.messages)).toContain('try again')
			expect(JSON.stringify(calls.at(-1)!.input.messages)).not.toContain('remove me')
			calls.at(-1)!.push({ type: 'done', reason: 'end' })
			await until(() => !turns.state.running.has(id))
		}
	}
})

test('intervening rewrite after accepted model plan produces complete tool error and drops nothing', async () => {
	let c = client(), id = created(c), original = tools.run
	tools.run = async (call, ctx) => {
		let result = await original(call, ctx)
		if (call.name === 'command' && contextTransitions.pending(id)?.kind === 'rebase') history.append(id, { type: 'reset' })
		return result
	}
	try {
		c.conn.send({ type: 'submit', sessionId: id, text: 'keep me' })
		await until(() => calls.length === 1)
		let n = history.readSync(id).find((r) => r.type === 'user')!.n
		calls[0]!.push(command(`/rebase run drop ${n}`), { type: 'done', reason: 'tool_use' })
		await until(() => calls.length === 2)
		let raw = await records(id)
		expect(raw.some((r) => r.type === 'rebase')).toBe(false)
		expect(raw.findLast((r) => r.type === 'user')).toMatchObject({ blocks: [{ type: 'tool_result', isError: true, output: expect.stringContaining('context was rewritten') }] })
		calls[1]!.push({ type: 'done', reason: 'end' })
		await until(() => !turns.state.running.has(id))
	} finally { tools.run = original }
})

test('boundary serializes steering, advisory and queued inbox delivery after a retained rebase result', async () => {
	let c = client(), id = created(c), original = tools.run, release!: () => void
	tools.run = async (call, ctx) => {
		let result = await original(call, ctx)
		if (call.id === 'rebase') await new Promise<void>((resolve) => release = resolve)
		return result
	}
	try {
		c.conn.send({ type: 'submit', sessionId: id, text: 'original' })
		await until(() => calls.length === 1)
		let n = history.readSync(id).find((r) => r.type === 'user')!.n
		calls[0]!.push(command(`/rebase edit ${n} "rewritten"`), { type: 'done', reason: 'tool_use' })
		await until(() => !!release)
		prompts.submit(id, 'steering message', undefined, 'interrupt')
		prompts.submit(id, 'advisory message', undefined, 'interject', { from: 'other', advisory: true })
		prompts.submit(id, 'queued message', undefined, 'queue')
		release()
		await until(() => calls.length === 2)
		let messages = JSON.stringify(calls[1]!.input.messages)
		expect(messages).toContain('rewritten')
		expect(messages).toContain('steering message')
		expect(messages).toContain('advisory message')
		expect(messages).not.toContain('queued message')
		expect(messages.indexOf('Rebase applied (')).toBeLessThan(messages.indexOf('steering message'))
		calls[1]!.push({ type: 'done', reason: 'end' })
		await until(() => calls.length === 3)
		expect(JSON.stringify(calls[2]!.input.messages)).toContain('queued message')
		calls[2]!.push({ type: 'done', reason: 'end' })
		await until(() => !turns.state.running.has(id))
	} finally { tools.run = original }
})

test('durable rebase recovery applies once, settles self-removed results and resumes or stays paused', async () => {
	for (let gap of ['intent', 'applied'] as const) for (let paused of [false, true]) {
		let c = client(), id = created(c), before = calls.length
		history.submit(id, 'recover this prompt')
		let snapshot = rebaseRows.build(history.readSync(id))
		history.append(id, { type: 'assistant', block: command('/rebase drop 2-') })
		let intent = { id: `recover-${gap}-${paused}`, kind: 'rebase' as const, sender: { origin: 'model' as const }, rebase: { sparse: rebaseSparse.parse('drop 2-', snapshot), resume: true as const, ...(paused && { paused: true as const }), call: 'rebase' } }
		contextTransitions.output(id, '/rebase accepted', { transition: intent })
		if (gap === 'applied') {
			history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: 'rebase', output: 'settled' }] })
			let prepared = rebaseAgent.prepare(id, intent.rebase)
			history.append(id, { type: 'rebase', ...prepared.plan, transition: intent.id })
		}
		restartHost()
		await turns.recover()
		if (paused) expect(calls.length).toBe(before)
		else {
			await until(() => calls.length === before + 1)
			expect(JSON.stringify(calls.at(-1)!.input.messages)).toContain('recover this prompt')
			expect(JSON.stringify(calls.at(-1)!.input.messages)).not.toContain('/rebase')
			calls.at(-1)!.push({ type: 'done', reason: 'end' })
			await until(() => !turns.state.running.has(id))
		}
		expect(history.readSync(id).filter((r) => r.type === 'rebase')).toHaveLength(1)
		expect(contextTransitions.pending(id)).toBeUndefined()
	}
})

test('dropping a final reply continues the exposed unfinished turn; a completed reply stays idle', async () => {
	for (let dropReply of [true, false]) {
		let c = client(), id = created(c), before = calls.length
		history.submit(id, 'task')
		history.append(id, { type: 'assistant', block: { type: 'text', text: 'commentary' } })
		history.append(id, { type: 'assistant', block: { type: 'text', text: 'final reply' } })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		history.append(id, { type: 'notice', text: 'later' })
		let snapshot = rebaseRows.build(history.readSync(id))
		let target = snapshot.rows.find((r) => r.kind === 'assistant' && r.text === (dropReply ? 'final reply' : 'commentary'))!.n
		rebaseAgent.request(id, `drop ${target}`, false, false)
		let report = history.readSync(id).findLast((r) => r.type === 'output' && r.text.startsWith('Rebase applied ('))
		if (dropReply) {
			expect(report).toMatchObject({ text: expect.stringContaining('continuing unfinished turn') })
			await until(() => calls.length === before + 1)
			calls.at(-1)!.push({ type: 'done', reason: 'end' })
			await until(() => !turns.state.running.has(id))
		} else {
			expect(report).toMatchObject({ text: expect.not.stringContaining('continuing') })
			expect(calls.length).toBe(before)
		}
	}
})
