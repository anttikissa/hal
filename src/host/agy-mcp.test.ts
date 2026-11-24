import { expect, test } from 'bun:test'
import { createConnection } from 'net'
import { testHome, useHost } from './host-fixture.test.ts'
import { agyMcp } from './agy-mcp.ts'
import { sessions } from './sessions.ts'
import { tools, type Tool } from './tools.ts'

useHost()

function rpcClient(port: number) {
	let socket = createConnection({ host: '127.0.0.1', port })
	let buf = ''
	let queue: Record<string, any>[] = []
	let waiters: ((msg: Record<string, any>) => void)[] = []
	let connected = new Promise<void>((resolve, reject) => {
		socket.once('connect', () => resolve())
		socket.once('error', reject)
	})
	socket.on('data', (chunk: Buffer) => {
		buf += chunk.toString('utf8')
		let lines = buf.split('\n')
		buf = lines.pop()!
		for (let line of lines) {
			if (!line.trim()) continue
			let msg = JSON.parse(line)
			let next = waiters.shift()
			if (next) next(msg)
			else queue.push(msg)
		}
	})
	let recv = (): Promise<Record<string, any>> =>
		queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve))
	let sendRaw = (data: string | Uint8Array) => socket.write(data)
	let send = (msg: Record<string, unknown>) => socket.write(`${JSON.stringify(msg)}\n`)
	let close = () => socket.destroy()
	return { connected, send, sendRaw, recv, close, socket }
}

test('list exposes help, renders conditional tool guides, annotates read-only tools, and keeps shell/file tools excluded', () => {
	let interactive = sessions.create({ cwd: testHome(), model: 'agy/gemini-4-neon', interactive: true }).id
	let subagent = sessions.create({ cwd: testHome(), model: 'agy/gemini-4-neon', interactive: false }).id

	let listed = agyMcp.list(interactive)
	let names = listed.map((t) => t.name)
	expect(names).toContain('help')
	expect(names).toContain('inspect')
	expect(names).toContain('command')
	for (let omitted of ['bash', 'read', 'edit', 'grep']) expect(names).not.toContain(omitted)

	let helpTool = listed.find((t) => t.name === 'help')!
	expect(helpTool.annotations).toEqual({ readOnlyHint: true })
	expect(helpTool.description).toStartWith('## HELP')

	let sendInteractive = listed.find((t) => t.name === 'send')!
	expect(sendInteractive.annotations).toBeUndefined()
	expect(sendInteractive.description).not.toContain(':::')
	expect(sendInteractive.description).toContain('purpose shows the summary')

	let sendSubagent = agyMcp.list(subagent).find((t) => t.name === 'send')!
	expect(sendSubagent.description).not.toContain(':::')
	expect(sendSubagent.description).not.toContain('purpose shows the summary')
})

test('call runs HELP SUBAGENTS and strips agy toolSummary unless declared by the tool', async () => {
	let sid = sessions.create({ cwd: testHome(), model: 'agy/gemini-4-neon' }).id
	let signal = new AbortController().signal

	let helpRes = await agyMcp.call(sid, 'help', { name: 'SUBAGENTS', toolSummary: 'Check subagent rules' }, signal)
	expect(helpRes.isError).toBeUndefined()
	expect(String(helpRes.content[0]?.text)).toContain('SUBAGENTS:')

	let seen: Record<string, unknown>[] = []
	let origAll = tools.all
	let custom: Tool[] = [
		{
			name: 'probe_strip',
			parameters: { type: 'object', properties: { value: { type: 'string' } } },
			async run(input) {
				seen.push(input)
				return 'ok'
			},
		},
		{
			name: 'probe_keep',
			parameters: { type: 'object', properties: { toolSummary: { type: 'string' } } },
			async run(input) {
				seen.push(input)
				return 'ok'
			},
		},
	]
	tools.all = () => [...origAll(), ...custom]
	try {
		await agyMcp.call(sid, 'probe_strip', { value: 'x', toolSummary: 'injected' }, signal)
		await agyMcp.call(sid, 'probe_keep', { toolSummary: 'declared' }, signal)
	} finally {
		tools.all = origAll
	}
	expect(seen).toEqual([{ value: 'x' }, { toolSummary: 'declared' }])
})

test('TCP bridge handles initialize, notifications/tools/list_changed, split UTF-8, EOF flush, and large responses without truncation', async () => {
	let sid = sessions.create({ cwd: testHome(), model: 'agy/gemini-4-neon' }).id
	let turnAbort: AbortController | undefined
	let origAll = tools.all
	let big = 'x'.repeat(2_000_000)
	let echoTool: Tool = {
		name: 'probe_big',
		parameters: { type: 'object', properties: { text: { type: 'string' }, big: { type: 'boolean' } } },
		async run(input) {
			return input.big ? big : String(input.text ?? '')
		},
	}
	tools.all = () => [...origAll(), echoTool]
	let bridge = agyMcp.start(sid, () => turnAbort?.signal)
	let c1 = rpcClient(bridge.port)
	let c2 = rpcClient(bridge.port)
	try {
		await Promise.all([c1.connected, c2.connected])

		// 1. Initialize advertises tools.listChanged.
		c1.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
		let init = await c1.recv()
		expect(init.result.capabilities.tools).toEqual({ listChanged: true })

		// 2. Calls outside an active turn are rejected.
		c1.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'help', arguments: {} } })
		let outside = await c1.recv()
		expect(outside.result.isError).toBe(true)
		expect(outside.result.content[0].text).toContain('only during a turn')

		// 3. Concurrent split multi-byte UTF-8 chunks across two sockets do not corrupt each other.
		turnAbort = new AbortController()
		let req1 = Buffer.from(
			`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'probe_big', arguments: { text: 'äöü🚀' } } })}\n`,
		)
		let req2 = Buffer.from(
			`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'probe_big', arguments: { text: '日本語🎉' } } })}\n`,
		)
		let split1 = req1.indexOf(0xf0) + 2
		let split2 = req2.indexOf(0xe6) + 1
		c1.sendRaw(req1.subarray(0, split1))
		c2.sendRaw(req2.subarray(0, split2))
		await Bun.sleep(10)
		c2.sendRaw(req2.subarray(split2))
		c1.sendRaw(req1.subarray(split1))
		let [r1, r2] = await Promise.all([c1.recv(), c2.recv()])
		expect(r1.result.content[0].text).toBe('äöü🚀')
		expect(r2.result.content[0].text).toBe('日本語🎉')

		// 4. Large response (> kernel send buffer) flushes completely via drain without truncation.
		let origCap = tools.cap
		tools.cap = (output) => output
		try {
			c1.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'probe_big', arguments: { big: true } } })
			let bigReply = await c1.recv()
			expect(bigReply.result.content[0].text.length).toBe(big.length)
		} finally {
			tools.cap = origCap
		}

		// 5. Plugin hot-reload notification reaches connected sockets.
		agyMcp.notifyToolsChanged()
		let notif = await c1.recv()
		expect(notif).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })

		// 6. Half-closed client sending a line without trailing newline still gets a reply.
		let c3 = rpcClient(bridge.port)
		await c3.connected
		c3.socket.end(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }))
		let pong = await c3.recv()
		expect(pong).toEqual({ jsonrpc: '2.0', id: 6, result: {} })
		c3.close()
	} finally {
		c1.close()
		c2.close()
		bridge.stop()
		tools.all = origAll
	}
})
