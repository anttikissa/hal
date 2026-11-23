// Recovery on a new host (turns.recover, task zk): it finds every
// unfinished turn and queued message however far back it sits.

import { expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { agy } from './agy.ts'
import { agyPrompt } from './agy-prompt.ts'
import { busy } from './busy.ts'
import { restartProcess } from './commands/restart.ts'
import { history } from './history.ts'
import { calls, client, restartHost, testHome, until, useHost } from './host-fixture.test.ts'
import { jobs } from './jobs.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { provider } from './provider.ts'
import { restartNote } from './restart-note.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'

useHost()

const texts = (message: any) => message.blocks.map((b: any) => b.text)

test('a queued message written 1 MB before the end of history runs after a host restart', async () => {
	let id = sessions.create({ cwd: '/tmp/w', model: 'fake/m1' }).id
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'go' }] })
	let queuedAt = history.append(id, { type: 'inbox', id: 'q1', text: 'later', delivery: 'after-turn' }).ts
	// The turn goes on for a megabyte of tool rounds, then the host dies
	// after its end, before the queued prompt.
	for (let i = 0; i < 100; i++) {
		history.append(id, { type: 'assistant', block: { type: 'tool_call', id: `t${i}`, name: 'read', input: {} } })
		history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: `t${i}`, output: 'y'.repeat(10_000) }] })
	}
	history.append(id, { type: 'turn_end', status: 'completed', reason: 'end', usage: {} })
	restartHost()
	await turns.recover()
	await until(() => calls.length === 1)
	expect(texts(calls[0]!.input.messages.at(-1))).toEqual([
		expect.stringContaining(
			`<hal-note>Message was queued at ${queuedAt}, take that into account when reading it.</hal-note>\nlater`,
		),
	])
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => !turns.state.running.has(id))
	// Nothing is left: the next host runs nothing and drops it as busy.
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(1)
	expect(busy.list()).toEqual([])
})

test('a turn in a closed tab stays paused after a restart', async () => {
	let a = client()
	let tab = (id: string) => {
		a.conn.send({ type: 'tab-new', cwd: testHome(), id } as any)
		return (a.events.find((e: any) => e.type === 'ack' && e.id === id) as any).tab as string
	}
	let keep = tab('keep')
	let id = tab('work')
	sessions.open(id).model = 'fake/m1'
	a.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'tab-close', sessionId: id, id: 'close' } as any)
	await until(() => history.readSync(id).some((r) => r.type === 'turn_end'))
	expect(tabs.file().open).toEqual([keep])
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(1)
	expect(history.readSync(id).findLast((r) => r.type === 'turn_end')).toMatchObject({ status: 'paused' })
})

function withNoAutoRetry<T>(run: () => Promise<T>): Promise<T> {
	let prev = provider.state.providers.nr
	provider.state.providers.nr = {
		noAutoRetry: true,
		request: () => ({ url: '', headers: {}, body: null }),
		async *parse() {},
	}
	return run().finally(() => {
		if (prev) provider.state.providers.nr = prev
		else delete provider.state.providers.nr
	})
}

function runSlash(id: string, text: string, origin?: 'model'): Promise<any> {
	let [head, ...rest] = text.trim().slice(1).split(/\s+/)
	return new Promise((resolve, reject) => {
		let refused = slash.command(id, text, { name: head!, args: rest.join(' ') }, undefined, undefined, resolve, origin)
		if (refused) reject(new Error(refused))
	})
}

test('self-initiated model /restart auto-continues a noAutoRetry turn once while external sessions stop with notifications and keep queued mail', () =>
	withNoAutoRetry(async () => {
		let origExit = restartProcess.run
		restartProcess.run = () => {}
		try {
			let a = client()
			let self = sessions.create({ cwd: testHome(), model: 'nr/m1' }).id
			let other = sessions.create({ cwd: testHome(), model: 'nr/m1' }).id
			let parent = sessions.create({ cwd: testHome(), model: 'fake/m1' }).id
			let child = sessions.create({ cwd: testHome(), model: 'nr/m1' }).id
			Object.assign(sessions.open(child), { parent, spawn: 'subagent' as const })
			liveFiles.save(sessions.open(child))
			for (let id of [self, other, parent, child]) tabs.insert(id, tabs.file().open.length)

			history.append(self, { type: 'user', blocks: [{ type: 'text', text: 'restart now' }] })
			history.append(other, { type: 'user', blocks: [{ type: 'text', text: 'keep working' }] })
			history.append(other, { type: 'inbox', id: 'q1', text: 'afterwards', delivery: 'after-turn' })
			history.append(child, { type: 'user', blocks: [{ type: 'text', text: 'child task', from: parent }] })

			// Model runs /restart host in `self`; exit happens before any hosted_tool record arrives.
			let reply = await runSlash(self, '/restart host', 'model')
			expect(reply.say).toBe('restarting the host')

			// Age the warning timestamp past 60 s: warning expires, recovery provenance still authorizes once.
			let file = `${paths.stateDir()}/restart.ason`
			let note = ason.parse(await Bun.file(file).text()) as Record<string, any>
			writeFileSync(file, ason.stringify({ ...note, at: Date.now() - 120_000 }) + '\n')

			restartHost()
			a = client()
			a.conn.send({ type: 'open', sessionId: other })
			a.conn.send({ type: 'open', sessionId: child })
			await until(() => a.events.some((e: any) => e.type === 'snapshot' && e.sessionId === child))

			await restartNote.announce()
			await turns.recover()

			// Only `self` continues among nr sessions, with resumeOnly and explicit do-not-repeat-restart guidance.
			await until(() => calls.some((c) => c.input.sessionId === self))
			let selfCall = calls.find((c) => c.input.sessionId === self)!
			expect(selfCall.input.resumeOnly).toBe(true)
			expect(JSON.stringify(selfCall.input.messages.at(-1))).toContain('Your requested host restart completed')
			expect(calls.some((c) => c.input.sessionId === other || c.input.sessionId === child)).toBe(false)

			// `other` stopped with error, broadcast both turn-end and state, and left its queued message untouched.
			expect(history.readSync(other).at(-1)).toMatchObject({ type: 'turn_end', status: 'error' })
			expect(a.of('turn-end').some((e: any) => e.sessionId === other && e.status === 'error')).toBe(true)
			expect(a.of('state').some((e: any) => e.sessionId === other && e.state?.type === 'error')).toBe(true)
			expect(status.inboxOf(other).map((m) => m.id)).toEqual(['q1'])

			// `child` reported its failure back to `parent`.
			let reported = () =>
				history
					.readSync(parent)
					.some(
						(r) =>
							r.type === 'user' &&
							r.blocks.some(
								(b) => b.type === 'text' && b.from === child && b.text.includes('Host restarted while nr was running'),
							),
					)
			await until(reported)
			expect(reported()).toBe(true)

			// One-shot consumption: a second restart without a new accepted /restart stops `self` with an error.
			let beforeSecond = calls.length
			restartHost()
			await turns.recover()
			expect(calls.slice(beforeSecond).some((c) => c.input.sessionId === self)).toBe(false)
			expect(history.readSync(self).at(-1)).toMatchObject({ type: 'turn_end', status: 'error' })
		} finally {
			await Bun.sleep(250)
			restartProcess.run = origExit
		}
	}))

test('refused, user-origin, and stale /restart markers never authorize noAutoRetry recovery', () =>
	withNoAutoRetry(async () => {
		let origExit = restartProcess.run
		restartProcess.run = () => {}
		try {
			// 1. Refused by unsafeToStop guard.
			let id = sessions.create({ cwd: testHome(), model: 'nr/m1' }).id
			tabs.insert(id, tabs.file().open.length)
			history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'go' }] })
			jobs.state.running.set(`${id}:1`, {
				sessionId: id,
				stop() {},
				unsafe: { input: { command: 'migrate', unsafeToStop: true }, at: Date.now() },
			})
			let refused = await runSlash(id, '/restart host', 'model')
			expect(refused.error).toContain('THIS IS UNSAFE')
			jobs.state.running.delete(`${id}:1`)
			restartHost()
			await turns.recover()
			expect(calls.length).toBe(0)
			expect(history.readSync(id).at(-1)).toMatchObject({ type: 'turn_end', status: 'error' })

			// 2. User-origin /restart host.
			let userId = sessions.create({ cwd: testHome(), model: 'nr/m1' }).id
			tabs.insert(userId, tabs.file().open.length)
			history.append(userId, { type: 'user', blocks: [{ type: 'text', text: 'go' }] })
			let userReply = await runSlash(userId, '/restart host')
			expect(userReply.say).toBe('restarting the host')
			restartHost()
			await turns.recover()
			expect(calls.length).toBe(0)
			expect(history.readSync(userId).at(-1)).toMatchObject({ type: 'turn_end', status: 'error' })

			// 3. Stale marker from an earlier completed turn.
			let staleId = sessions.create({ cwd: testHome(), model: 'nr/m1' }).id
			tabs.insert(staleId, tabs.file().open.length)
			history.append(staleId, { type: 'user', blocks: [{ type: 'text', text: 'first' }] })
			await runSlash(staleId, '/restart host', 'model')
			history.append(staleId, { type: 'turn_end', status: 'completed', usage: {} })
			history.append(staleId, { type: 'user', blocks: [{ type: 'text', text: 'second' }] })
			restartHost()
			await turns.recover()
			expect(calls.length).toBe(0)
			expect(history.readSync(staleId).at(-1)).toMatchObject({ type: 'turn_end', status: 'error' })
		} finally {
			await Bun.sleep(250)
			jobs.state.running.clear()
			restartProcess.run = origExit
		}
	}))

test('repeated self-initiated /restart stops at the recovery cap', () =>
	withNoAutoRetry(async () => {
		let origExit = restartProcess.run
		restartProcess.run = () => {}
		try {
			let id = sessions.create({ cwd: testHome(), model: 'nr/m1' }).id
			tabs.insert(id, tabs.file().open.length)
			history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'loop' }] })
			for (let i = 0; i < 5; i++) {
				history.append(id, { type: 'continue', reason: 'retry' })
				history.append(id, {
					type: 'assistant',
					block: {
						type: 'hosted_tool',
						id: `c${i}`,
						name: 'command',
						input: { command: '/restart host' },
						output: 'ok',
					},
				})
			}
			await runSlash(id, '/restart host', 'model')
			restartHost()
			await turns.recover()
			expect(calls.length).toBe(0)
			expect(history.readSync(id).at(-1)).toMatchObject({
				type: 'turn_end',
				status: 'paused',
				pauseReason: expect.stringContaining('continued 5 times'),
			})
		} finally {
			await Bun.sleep(250)
			restartProcess.run = origExit
		}
	}))

test('agyPrompt strips hosted tool notes without dropping sibling continuation notices', () => {
	let content = agyPrompt.toContent(
		[
			{
				role: 'user',
				blocks: [
					{
						type: 'text',
						text: '<hal-note>Your command ran on the provider: { command: "/restart host" }\nrestarting the host</hal-note>\n<hal-note>2026-11-23T18:50:53Z\nYour requested host restart completed. Do not run it again.</hal-note>',
					},
				],
			},
		],
		{ model: 'gemini-4-neon', messages: [] },
		false,
	)
	expect(content).toEqual([
		{
			type: 'text',
			text: '<hal-note>2026-11-23T18:50:53Z\nYour requested host restart completed. Do not run it again.</hal-note>',
		},
	])
})

test('agy resumeOnly requires successful session/resume and matching prefix, while explicit prompts still fall back to seeding', async () => {
	let origCmd = agy.command
	let logFile = `${testHome()}/acp.log`
	let modeFile = `${testHome()}/acp.mode`
	let fakeAgy = `${testHome()}/fake-acp.ts`
	writeFileSync(
		fakeAgy,
		`import { appendFileSync, readFileSync } from 'fs'
const log = ${JSON.stringify(logFile)}
const mode = ${JSON.stringify(modeFile)}
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
let buf = ''
for await (const chunk of Bun.stdin.stream()) {
	buf += new TextDecoder().decode(chunk)
	const lines = buf.split('\\n')
	buf = lines.pop()!
	for (const line of lines) {
		if (!line.trim()) continue
		const msg = JSON.parse(line)
		appendFileSync(log, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n')
		if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1 } })
		else if (msg.method === 'session/new') send({ id: msg.id, result: { sessionId: 'acp-new', models: { currentModelId: 'gemini-4-neon' } } })
		else if (msg.method === 'session/resume') {
			if (readFileSync(mode, 'utf8').trim() === 'fail-resume') send({ id: msg.id, error: { code: -32000, message: 'session expired' } })
			else send({ id: msg.id, result: {} })
		} else if (msg.method === 'session/set_model') send({ id: msg.id, result: {} })
		else if (msg.method === 'session/prompt') {
			send({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed-ok' } } } })
			send({ id: msg.id, result: { stopReason: 'end' } })
		}
	}
}
`,
	)
	agy.command = () => [process.execPath, fakeAgy]
	let readEvents = async (stream: ReadableStream<Uint8Array>) => {
		let text = await new Response(stream).text()
		return text
			.split('\n\n')
			.filter((c) => c.startsWith('data: '))
			.map((c) => JSON.parse(c.slice(6)))
	}
	let rpcMethods = async () =>
		(await Bun.file(logFile).text())
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l).method as string)
	try {
		let cwd = testHome()
		let id = sessions.create({ cwd, model: 'agy/gemini-4-neon' }).id
		let base = [{ role: 'user' as const, blocks: [{ type: 'text' as const, text: 'Proceed.' }] }]
		writeFileSync(
			`${paths.sessionDir(id)}/agy.ason`,
			ason.stringify({ acpSession: 'acp-1', cwd, prefix: 1, hash: agyPrompt.hash(base) }) + '\n',
		)

		// 1. resumeOnly succeeds when session/resume succeeds and prefix matches (no session/new).
		writeFileSync(modeFile, 'ok')
		let ok = await readEvents(
			await agy.open({
				model: 'gemini-4-neon',
				sessionId: id,
				resumeOnly: true,
				messages: [
					...base,
					{ role: 'user', blocks: [{ type: 'text', text: 'Your requested host restart completed.' }] },
				],
			}),
		)
		expect(ok).toContainEqual({ type: 'text', text: 'resumed-ok' })
		expect(await rpcMethods()).not.toContain('session/new')

		// 2. resumeOnly fails without session/new when history prefix diverged.
		agy.stop(id)
		writeFileSync(logFile, '')
		let diverged = await readEvents(
			await agy.open({
				model: 'gemini-4-neon',
				sessionId: id,
				resumeOnly: true,
				messages: [{ role: 'user', blocks: [{ type: 'text', text: 'edited prompt' }] }],
			}),
		)
		expect(diverged.find((e) => e.type === 'error')?.message).toContain('diverged')
		expect(await rpcMethods()).not.toContain('session/new')

		// 3. resumeOnly fails without session/new when session/resume fails.
		agy.stop(id)
		writeFileSync(logFile, '')
		writeFileSync(modeFile, 'fail-resume')
		let failed = await readEvents(
			await agy.open({
				model: 'gemini-4-neon',
				sessionId: id,
				resumeOnly: true,
				messages: [...base, { role: 'user', blocks: [{ type: 'text', text: 'continue' }] }],
			}),
		)
		expect(failed.find((e) => e.type === 'error')?.message).toContain('session expired')
		expect(await rpcMethods()).not.toContain('session/new')

		// 4. Explicit user continuation (no resumeOnly) still falls back to session/new + transcript seed.
		agy.stop(id)
		writeFileSync(logFile, '')
		let seeded = await readEvents(
			await agy.open({
				model: 'gemini-4-neon',
				sessionId: id,
				messages: [...base, { role: 'user', blocks: [{ type: 'text', text: 'explicit retry' }] }],
			}),
		)
		expect(seeded).toContainEqual({ type: 'text', text: 'resumed-ok' })
		expect(await rpcMethods()).toContain('session/new')
	} finally {
		agy.stopAll()
		agy.command = origCmd
	}
})
