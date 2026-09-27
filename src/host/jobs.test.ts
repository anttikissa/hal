// Background bash (task v0): the call returns at once, the result comes
// later as a message from 'bash <id>'.

import { expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { calls, client, restartHost, testHome, toolSession, until, useHost } from './host-fixture.test.ts'
import { jobs } from './jobs.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'

useHost()

type C = ReturnType<typeof client>
const bg = (command: string, id = 'b1') => ({ type: 'tool_call' as const, id, name: 'bash', input: { command, description: 'Run it', background: true } })
const resultOf = (n: number) => calls[n]!.input.messages.at(-1).blocks.find((b: any) => b.type === 'tool_result')
const texts = (n: number) =>
	calls[n]!.input.messages
		.at(-1)
		.blocks.filter((b: any) => b.type === 'text')
		.map((b: any) => b.text)
		.join('\n')
const slow = async (check: () => unknown) => {
	for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10)
	expect(check()).toBeTruthy()
}

// A session (a tab) whose model runs `command` in the background;
// resolves with the id the call returned, once the next round started.
async function started(c: C, command: string): Promise<{ id: string; job: string }> {
	let id = toolSession(c)
	tabs.insert(id, 0)
	c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push(bg(command), { type: 'done', reason: 'tool_use' })
	await slow(() => calls.length === 2)
	let job = /^started in background as (\S+)$/.exec(resultOf(1).output)?.[1]
	expect(job).toBeDefined()
	return { id, job: job! }
}

test('a command that fails at once returns its output and status like a foreground one', async () => {
	let c = client()
	let id = toolSession(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push(bg('echo nope; exit 3'), { type: 'done', reason: 'tool_use' })
	await slow(() => calls.length === 2)
	expect(resultOf(1).output).toBe('[exit 3]\nnope\n')
	expect(jobs.running(id)).toEqual([])
})

test('the result reaches the running turn at its next request, as a message from bash <id>', async () => {
	let c = client()
	let { id, job } = await started(c, 'sleep 0.2; echo built; exit 4')
	// The turn went on; the command still runs.
	calls[1]!.push({ type: 'tool_call', id: 'b2', name: 'bash', input: { command: 'sleep 0.5', description: 'Wait' } }, { type: 'done', reason: 'tool_use' })
	await slow(() => calls.length === 3)
	expect(texts(2)).toContain(`[Inbox · bash ${job}]`)
	expect(texts(2)).toContain('[exit 4]\nbuilt')
	expect(jobs.running(id)).toEqual([])
	expect(sessions.open(id).background).toBeUndefined()
})

test('an idle session gets the result as a turn of its own', async () => {
	let c = client()
	let { id, job } = await started(c, 'sleep 0.2; echo built')
	calls[1]!.push({ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' })
	await until(() => c.views.get(id)?.state.type === 'idle')
	await slow(() => calls.length === 3)
	expect(texts(2)).toContain(`[Inbox · bash ${job}]\n[exit 0]\nbuilt`)
})

test('Escape does not stop the command; the paused session keeps its result waiting', async () => {
	let c = client()
	let { id, job } = await started(c, 'sleep 0.2; echo done')
	c.conn.send({ type: 'pause', sessionId: id })
	await slow(() => c.views.get(id)?.inbox.length)
	expect(c.views.get(id)!.inbox).toMatchObject([{ text: '[exit 0]\ndone\n', label: `bash ${job}` }])
	expect(calls.length).toBe(2)
})

test('closing the tab kills the command and nothing is delivered', async () => {
	let c = client()
	let { id } = await started(c, `sleep 0.3; touch ${testHome()}/ran`)
	calls[1]!.push({ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' })
	await until(() => c.views.get(id)?.state.type === 'idle')
	tabs.insert(toolSession(c), 1)
	expect(tabs.close(id)).toBeUndefined()
	await Bun.sleep(600)
	expect(existsSync(`${testHome()}/ran`)).toBe(false)
	expect(calls.length).toBe(2)
	expect(sessions.open(id).background).toBeUndefined()
})

test('after a restart the session hears the command was lost, and it no longer runs', async () => {
	let c = client()
	let { id, job } = await started(c, `sleep 0.3; touch ${testHome()}/ran`)
	calls[1]!.push({ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' })
	await until(() => c.views.get(id)?.state.type === 'idle')
	restartHost()
	await jobs.lost()
	await slow(() => calls.length === 3)
	expect(texts(2)).toContain(`bash ${job} was lost when Hal restarted`)
	await Bun.sleep(400)
	expect(existsSync(`${testHome()}/ran`)).toBe(false)
	expect(sessions.open(id).background).toBeUndefined()
})
