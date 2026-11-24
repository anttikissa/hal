import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { calls, client, testHome, toolSession, until, useHost } from './host-fixture.test.ts'
import { agy } from './agy.ts'
import { agyMcp } from './agy-mcp.ts'
import { auth } from './auth.ts'
import { host } from './host.ts'
import { history } from './history.ts'
import { jobs } from './jobs.ts'
import { nativeTool } from './native-tool.ts'
import { prompts } from './prompts.ts'
import { provider } from './provider.ts'
import { provider as agyProvider } from './providers/agy.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { subagents } from './subagents.ts'
import { tabs } from './tabs.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'
import { work } from './work.ts'

useHost()

function invoke(self: string, cmd: string) {
	let resolved = nativeTool.resolve(cmd, { sessionId: self, cwd: testHome() })
	let call = { type: 'tool_call' as const, id: crypto.randomUUID(), ...resolved }
	let record = history.append(self, { type: 'assistant', block: call })
	let promise = tools
		.run(call, { sessionId: self, cwd: testHome(), signal: new AbortController().signal })
		.then((result) => {
			history.results(self, [result])
			host.broadcast(self, { type: 'tool-results', sessionId: self, results: [result] })
			return result
		})
	return { promise, ref: `t${record.n}` }
}

async function background(self: string, gate: string, unsafe = false) {
	let command = `echo ready; while [ ! -e '${testHome()}/${gate}' ]; do sleep 0.05; done; echo completed`
	let started = invoke(self, `BASH ${JSON.stringify(command)} { background: true, unsafeToStop: ${unsafe} }`)
	expect((await started.promise).output).toContain('started in background')
	return started.ref
}

function owned(parent: string, name: string, limit = 0, callId?: string) {
	return subagents.spawn(parent, {
		kind: 'subagent-leave-open',
		task: name,
		name,
		cwd: testHome(),
		limit,
		fork: false,
		callId,
	})
}

test('shared numeric targets inspect and stop a background call with its partial output retained', async () => {
	let self = toolSession(client())
	let ref = await background(self, 'gate')
	for (let spelling of [ref, `#${ref}`, ref.slice(1)]) {
		let view = await invoke(self, `INSPECT ${spelling}`).promise
		expect(view.output).toContain(`${ref}: running`)
		expect(view.output).toContain('ready')
	}
	let stopped = await invoke(self, `STOP ${ref.slice(1)}`).promise
	expect(stopped.isError).toBeUndefined()
	expect(stopped.output).toContain(`Stopped ${ref}`)
	await until(() => jobs.running(self).length === 0)
	let view = await invoke(self, `INSPECT ${ref}`).promise
	expect(view.output).toContain('not running')
	expect(view.output).toContain('[stopped by the user]')
	expect(view.output).toContain('ready')
	expect((await invoke(self, 'STOP 999999').promise).isError).toBe(true)
})

test('WAIT selects a command, ignores unrelated completion and streaming, and catches an already finished target', async () => {
	let self = toolSession(client())
	let first = await background(self, 'first')
	let second = await background(self, 'second')
	let finished = false
	let waiting = invoke(self, `WAIT ${second}`).promise.then((r) => {
		finished = true
		return r
	})
	await until(() => work.listeners.size === 1)
	host.broadcast(self, { type: 'tool-output', sessionId: self, id: 'other', at: 0, chunk: 'progress' })
	expect(finished).toBe(false)
	writeFileSync(`${testHome()}/first`, '')
	await until(() => !jobs.state.running.has(`${self}:${first.slice(1)}`))
	expect(finished).toBe(false)
	await host.ready(self)
	let held = Promise.withResolvers<void>()
	host.state.opening.set(self, held.promise)
	writeFileSync(`${testHome()}/second`, '')
	await until(() => jobs.state.delivering.has(`${self}:${second.slice(1)}`))
	expect(finished).toBe(false)
	expect(work.inspect(work.target(self, second))).toContain('done')
	let any = invoke(self, 'WAIT').promise
	host.state.opening.delete(self)
	held.resolve()
	expect((await waiting).output).toContain(second)
	expect((await any).output).toContain(second)
	expect(work.listeners.size).toBe(0)
	expect((await invoke(self, `WAIT ${second}`).promise).output).toContain('needs attention')
	expect((await invoke(self, `WAIT ${self}`).promise).isError).toBe(true)
})

test('STOP walks owned descendants, leaves unrelated sessions and tabs intact, and resumes only the selected session', async () => {
	let c = client()
	let root = toolSession(c)
	tabs.insert(root, 0)
	let child = owned(root, 'child', 1)
	let grandchild = owned(child, 'grandchild')
	let unrelated = sessions.create({ cwd: testHome(), model: 'fake/m1' }).id
	tabs.insert(unrelated, 3)
	c.conn.send({ type: 'open', sessionId: unrelated })
	await until(() => c.views.has(unrelated))
	c.conn.send({ type: 'submit', sessionId: unrelated, text: 'unrelated work' })
	await until(() => calls.length === 3)
	let job = await background(child, 'child-gate')
	let before = [...tabs.file().open]
	await invoke(unrelated, `SEND ${child} "coordinate this work" { delivery: "emergency" }`).promise
	await until(() => calls.length === 4)
	expect(sessions.open(child).parent).toBe(root)
	let result = await invoke(root, `STOP ${root}`).promise
	expect(result.isError).toBeUndefined()
	for (let id of [root, child, grandchild]) expect(status.stateOf(id).type).toBe('paused')
	expect(status.stateOf(unrelated).type).toBe('running')
	expect(tabs.file().open).toEqual(before)
	await until(() => jobs.running(child).length === 0)
	expect(work.inspect(work.target(child, job))).toContain('[stopped by the user]')
	expect((await invoke(root, `COMMAND "/resume ${child}"`).promise).isError).toBeUndefined()
	expect(
		(await invoke(root, `SEND "${child}" "continue child" { delivery: "emergency" }`).promise).isError,
	).toBeUndefined()
	await until(() => calls.length === 5)
	expect(status.stateOf(grandchild).type).toBe('paused')
})

test('STOP a recorded SPAWN call cancels its child, not siblings, and WAIT exposes questions', async () => {
	let root = toolSession(client())
	let spawned = invoke(root, 'SPAWN { task: "first child", kind: "subagent-leave-open" }')
	expect((await spawned.promise).isError).toBeUndefined()
	await until(() => calls.length === 1)
	let child = sessions.openIds().find((id) => sessions.open(id).parentCall === Number(spawned.ref.slice(1)))!
	let sibling = owned(root, 'sibling')
	let waiting = invoke(root, `WAIT ${child}`).promise
	await until(() => work.listeners.size === 1)
	calls[0]!.push({ type: 'text', text: '<question>Choose a direction?</question>' }, { type: 'done', reason: 'end' })
	expect((await waiting).output).toContain(child)
	expect((await invoke(root, `INSPECT ${child}`).promise).output).toContain('Choose a direction?')
	expect((await invoke(root, `STOP ${spawned.ref}`).promise).isError).toBeUndefined()
	expect(status.stateOf(child).type).toBe('paused')
	expect(status.stateOf(sibling).type).toBe('running')
})

test('explicit STOP interrupts unsafe work too and reports its risk', async () => {
	let self = toolSession(client())
	let safe = await background(self, 'safe')
	let unsafe = await background(self, 'unsafe', true)
	let result = await invoke(self, `STOP ${self}`).promise
	expect(result.isError).toBeUndefined()
	expect(result.output).toContain('may leave broken state')
	await until(() => jobs.running(self).length === 0)
	expect(work.inspect(work.target(self, unsafe))).toContain('[stopped by the user]')
	expect(work.inspect(work.target(self, safe))).toContain('[stopped by the user]')
})

test('/kill all stops only this session’s background jobs and preserves a paused inbox', async () => {
	let c = client()
	let self = toolSession(c)
	let child = owned(self, 'child')
	await background(self, 'one')
	await background(self, 'two')
	let other = await background(child, 'other')
	status.state.states.set(self, { type: 'paused' })
	let result = await invoke(self, 'COMMAND "/kill all"').promise
	expect(result.isError).toBeUndefined()
	await until(() => jobs.running(self).length === 0)
	expect(status.stateOf(self).type).toBe('paused')
	expect(status.inboxOf(self)).toHaveLength(2)
	expect(status.stateOf(child).type).toBe('running')
	expect(work.active(work.target(child, other))).toBe(true)
})

test('/stop can interrupt one foreground command without pausing its session', async () => {
	let c = client()
	let self = toolSession(c)
	c.conn.send({ type: 'submit', sessionId: self, text: 'work' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{
			type: 'tool_call',
			id: 'foreground',
			name: 'bash',
			input: { command: 'echo ready; sleep 30', description: 'Foreground work' },
		},
		{ type: 'done', reason: 'tool_use' },
	)
	await until(() => c.of('tool-output').some((e) => e.chunk.includes('ready')))
	let record = history
		.readSync(self)
		.find((r) => r.type === 'assistant' && r.block.type === 'tool_call' && r.block.id === 'foreground')!
	let ref = `t${record.n}`
	expect(work.inspect(work.target(self, ref))).toContain('ready')
	c.conn.send({ type: 'submit', sessionId: self, text: `/stop ${ref}` })
	await until(() => calls.length === 2)
	expect(status.stateOf(self).type).toBe('running')
	expect(work.inspect(work.target(self, ref))).toContain('[stopped by the user]')
	expect(work.inspect(work.target(self, ref))).toContain('ready')
})

test('Escape exposes surviving subagents without stopping them or leaving a WAIT listener', async () => {
	let c = client()
	let self = toolSession(c)
	c.conn.send({ type: 'submit', sessionId: self, text: 'delegate' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{ type: 'tool_call', id: 'spawn', name: 'spawn', input: { task: 'child work', name: 'Child work' } },
		{ type: 'tool_call', id: 'wait', name: 'wait', input: {} },
		{ type: 'done', reason: 'tool_use' },
	)
	await until(() => work.listeners.size === 1)
	let child = sessions.openIds().find((id) => sessions.open(id).parent === self)!
	c.conn.send({ type: 'pause', sessionId: self })
	await until(() => work.listeners.size === 0)
	let notice = c.of('output').find((e) => e.text.includes('Still running'))!.text
	expect(notice).toContain(child)
	expect(notice).toContain('Child work')
	expect(notice).toContain(`/stop ${self}`)
	expect(status.stateOf(child).type).toBe('running')
	expect(status.stateOf(self).type).toBe('paused')
})

test('WAIT does not outrun a subagent report held for the owner’s snapshot', async () => {
	let c = client(),
		self = toolSession(c),
		child = owned(self, 'delayed report')
	await until(() => calls.length === 1)
	await host.ready(self)
	let held = Promise.withResolvers<void>()
	host.state.opening.set(self, held.promise)
	let waiting = invoke(self, `WAIT ${child}`)
	let finished = false
	waiting.promise.then(() => {
		finished = true
	})
	calls[0]!.push({ type: 'text', text: '<summary>ready after snapshot</summary>' }, { type: 'done', reason: 'end' })
	await until(() => subagents.delivering.has(child))
	expect(finished).toBe(false)
	host.state.opening.delete(self)
	held.resolve()
	await waiting.promise
	expect(status.inboxOf(self).some((m) => m.from === child && m.text.includes('ready after snapshot'))).toBe(true)
	expect(work.listeners.size).toBe(0)
})

test('agy inTurnSteer keeps MCP WAIT alive on subagent report, wakes cleanly on steers and queued prompts, and cancels on pause', async () => {
	let c = client()
	let fakeAgy = `${testHome()}/fake-agy-wait.ts`
	let logFile = `${testHome()}/fake-agy-wait.jsonl`
	writeFileSync(
		fakeAgy,
		`import { appendFileSync } from 'fs'
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
let buf = ''
let pending: number[] = []
for await (const chunk of process.stdin) {
	buf += new TextDecoder().decode(chunk)
	const lines = buf.split('\\n')
	buf = lines.pop()!
	for (const line of lines) {
		if (!line.trim()) continue
		const msg = JSON.parse(line)
		appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n')
		if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1 } })
		else if (msg.method === 'session/new') send({ id: msg.id, result: { sessionId: 'acp-wait', models: { currentModelId: 'gemini-4-neon' } } })
		else if (msg.method === 'session/set_model') send({ id: msg.id, result: {} })
		else if (msg.method === 'session/prompt') pending.push(msg.id)
		else if (msg.method === 'session/cancel') {
			for (const id of pending.splice(0)) send({ id, result: { stopReason: 'cancelled' } })
		}
	}
}
`,
	)
	let origCmd = agy.command
	let origStream = turns.stream
	let hadAgy = Object.hasOwn(provider.state.providers, 'agy')
	let origAgy = provider.state.providers.agy
	let rpcLog = () => {
		try {
			return readFileSync(logFile, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as { method: string; params?: any })
		} catch {
			return []
		}
	}
	mkdirSync(`${testHome()}/secrets`, { recursive: true, mode: 0o700 })
	writeFileSync(
		`${testHome()}/secrets/auth.ason`,
		ason.stringify({ agy: { email: 'test@example.com', keychain: true } }) + '\n',
		{ mode: 0o600 },
	)
	provider.state.providers.agy = agyProvider
	agy.command = () => [process.execPath, fakeAgy]
	turns.stream = (model, input, signal) =>
		model.startsWith('agy/') ? provider.stream(model, input, signal) : origStream(model, input, signal)
	try {
		let self = sessions.create({ cwd: testHome(), model: 'agy/gemini-4-neon', projectTrust: 'allow' }).id
		tabs.insert(self, 0)
		c.conn.send({ type: 'open', sessionId: self })
		await until(() => c.views.has(self))
		let child1 = subagents.spawn(self, {
			kind: 'subagent-leave-open',
			model: 'fake/m1',
			task: 'first worker',
			name: 'first worker',
			cwd: testHome(),
			limit: 0,
			fork: false,
		})
		let child2 = subagents.spawn(self, {
			kind: 'subagent-leave-open',
			model: 'fake/m1',
			task: 'second worker',
			name: 'second worker',
			cwd: testHome(),
			limit: 0,
			fork: false,
		})
		await until(() => calls.length === 2)
		c.conn.send({ type: 'submit', sessionId: self, text: 'wait on workers' })
		await until(() => !!agy.state.agents.get(self)?.turnAbort)
		let mcpSignal = () => agy.state.agents.get(self)!.turnAbort!.signal

		// 1. Subagent finishes: advisory report triggers inTurnSteer, WAIT resolves cleanly with attention.
		let wait1 = agyMcp.call(self, 'wait', { targets: [child1] }, mcpSignal())
		await until(() => work.listeners.size === 1)
		calls[0]!.push({ type: 'text', text: '<summary>worker 1 done</summary>' }, { type: 'done', reason: 'end' })
		let res1 = await wait1
		expect(res1.isError).toBeUndefined()
		expect((res1.content[0] as { text: string }).text).toContain(`Work needs attention: ${child1}`)
		expect(work.listeners.size).toBe(0)
		await until(() =>
			rpcLog().some((r) => r.method === 'session/prompt' && JSON.stringify(r.params).includes('worker 1 done')),
		)

		// 2. Human steer while child2 is still running: WAIT resolves cleanly (not error), no session/cancel.
		let wait2 = agyMcp.call(self, 'wait', { targets: [child2] }, mcpSignal())
		await until(() => work.listeners.size === 1)
		expect(prompts.submit(self, 'change plan', undefined, 'steer')).toBeUndefined()
		let res2 = await wait2
		expect(res2.isError).toBeUndefined()
		expect((res2.content[0] as { text: string }).text).toBe(
			'A message arrived; it follows. WAIT again if still needed.',
		)
		expect(work.listeners.size).toBe(0)
		await until(() =>
			rpcLog().some((r) => r.method === 'session/prompt' && JSON.stringify(r.params).includes('change plan')),
		)

		// 3. Queued prompt while child2 is still running: WAIT promotes it and triggers inTurnSteer.
		let wait3 = agyMcp.call(self, 'wait', { targets: [child2] }, mcpSignal())
		await until(() => work.listeners.size === 1)
		expect(prompts.submit(self, 'queued note', undefined, 'queue')).toBeUndefined()
		let res3 = await wait3
		expect(res3.isError).toBeUndefined()
		expect((res3.content[0] as { text: string }).text).toBe(
			'A message arrived; it follows. WAIT again if still needed.',
		)
		await until(() =>
			rpcLog().some((r) => r.method === 'session/prompt' && JSON.stringify(r.params).includes('queued note')),
		)
		expect(rpcLog().some((r) => r.method === 'session/cancel')).toBe(false)

		// 4. Pause/Escape cancels agy turn and aborts in-flight WAIT without leaking its listener.
		let wait4 = agyMcp.call(self, 'wait', { targets: [child2] }, mcpSignal())
		await until(() => work.listeners.size === 1)
		c.conn.send({ type: 'pause', sessionId: self })
		let res4 = await wait4
		expect(res4.isError).toBe(true)
		expect((res4.content[0] as { text: string }).text).toContain('Wait stopped')
		expect(work.listeners.size).toBe(0)
		await until(() => rpcLog().some((r) => r.method === 'session/cancel'))
	} finally {
		agy.stopAll()
		auth.close()
		agy.command = origCmd
		turns.stream = origStream
		if (hadAgy) provider.state.providers.agy = origAgy!
		else delete provider.state.providers.agy
	}
})
