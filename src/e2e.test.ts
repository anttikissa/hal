// End to end: real ./run processes on a temp home with fake credentials,
// talking to a fake Anthropic server. The home's local.ts stands a pipe
// in for the tty (stdin in, frames out) and points anthropic at the fake,
// so neither the real auth.ason nor the real API is touched.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from './common/ason.ts'

type Proc = { sub: Bun.Subprocess<'pipe', 'pipe', 'pipe'>; out: string; exit?: number }

let home = ''
let procs: Proc[] = []
let server: ReturnType<typeof Bun.serve>
// Every request's messages, and the held slow replies' releases.
let requests: any[][] = []
let aborted = 0
let holds: (() => void)[] = []

const enc = new TextEncoder()
const sseEvent = (e: any) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
const textDelta = (text: string) => sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
const finish = [
	sseEvent({ type: 'content_block_stop', index: 0 }),
	sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
	sseEvent({ type: 'message_stop' }),
]

const sse = (events: Uint8Array[]) =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				for (let e of events) c.enqueue(e)
				c.close()
			},
		}),
		{ headers: { 'content-type': 'text/event-stream' } },
	)

// "read <path>" asks for the read tool; a tool result is answered with
// SAW(<its first line>).
const toolUse = (path: string) => [
	sseEvent({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
	sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } }),
	sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path }) } }),
	sseEvent({ type: 'content_block_stop', index: 0 }),
	sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }),
	sseEvent({ type: 'message_stop' }),
]
const toolAnswer = (result: any) => [
	sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
	textDelta(`SAW(${String(result.content).split('\n')[0]})`),
	...finish,
]

// Answers "<prompt>" with "ECHO(<prompt>)". A prompt starting with
// "hold" streams PART1, then waits for release() to send PART2 and
// finish, or for the client to abort.
function reply(req: Request, body: any): Response {
	let messages = body.messages
	requests.push(messages)
	let lastBlock = messages.at(-1).content.at(-1)
	if (lastBlock.type === 'tool_result') return sse([sseEvent({ type: 'message_start', message: { usage: { input_tokens: 5 } } }), ...toolAnswer(lastBlock)])
	let prompt: string = lastBlock.text
	if (prompt.startsWith('read ')) return sse(toolUse(prompt.slice(5)))
	let stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(sseEvent({ type: 'message_start', message: { usage: { input_tokens: 5 } } }))
			c.enqueue(sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
			let end = () => {
				for (let e of finish) c.enqueue(e)
				c.close()
			}
			if (!prompt.startsWith('hold')) {
				c.enqueue(textDelta(`ECHO(${prompt})`))
				return end()
			}
			c.enqueue(textDelta('PART1'))
			req.signal.addEventListener('abort', () => aborted++)
			holds.push(() => {
				c.enqueue(textDelta(' PART2'))
				end()
			})
		},
	})
	return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

beforeEach(() => {
	requests = []
	aborted = 0
	holds = []
	home = mkdtempSync(`${tmpdir()}/hal-e2e-`)
	server = Bun.serve({ port: 0, idleTimeout: 0, fetch: async (req) => reply(req, await req.json()) })
	writeFileSync(`${home}/auth.ason`, ason.stringify({ anthropic: { apiKey: 'fake-key' } }) + '\n', { mode: 0o600 })
	writeFileSync(
		`${home}/local.ts`,
		`import { terminal } from ${JSON.stringify(`${import.meta.dir}/client/terminal.ts`)}
import { anthropic } from ${JSON.stringify(`${import.meta.dir}/host/anthropic.ts`)}
terminal.available = () => true
terminal.realIO = () => ({
	setRawMode() {},
	onData(fn) { process.stdin.on('data', fn) },
	write: (s) => process.stdout.write(s),
	exit: (code) => process.exit(code),
	stop() {},
	onContinue() {},
	onExit(fn) { process.on('exit', fn) },
	size: () => ({ rows: 40, cols: 200 }),
	onResize() {},
})
anthropic.apiUrl = () => 'http://127.0.0.1:${server.port}/v1/messages'
`,
	)
})

afterEach(async () => {
	// The whole group: killing ./run alone would orphan its bun child.
	for (let p of procs) {
		try {
			process.kill(-p.sub.pid, 'SIGKILL')
		} catch {}
	}
	await Promise.all(procs.map((p) => p.sub.exited))
	procs = []
	server.stop(true)
	rmSync(home, { recursive: true, force: true })
})

function run(): Proc {
	let sub = Bun.spawn(['./run'], {
		cwd: `${import.meta.dir}/..`,
		env: { ...process.env, HAL_HOME: home },
		// Its own process group, so afterEach can kill ./run with its child.
		detached: true,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	let p: Proc = { sub, out: '' }
	void (async () => {
		for await (let chunk of sub.stdout) p.out += new TextDecoder().decode(chunk)
	})()
	void sub.exited.then((code) => (p.exit = code))
	procs.push(p)
	return p
}

function type(p: Proc, s: string): void {
	p.sub.stdin.write(s)
	p.sub.stdin.flush()
}

async function until(what: string, check: () => boolean): Promise<void> {
	let deadline = Date.now() + 10_000
	while (!check()) {
		if (Date.now() > deadline) {
			let err = await Promise.all(procs.map((p) => (p.exit !== undefined ? new Response(p.sub.stderr).text() : '')))
			throw new Error(`timed out waiting for ${what}\n${procs.map((p) => JSON.stringify(p.out.slice(-500))).join('\n')}\n${err.join('\n')}`)
		}
		await Bun.sleep(10)
	}
}

// Output after `from`: what the process has shown since then.
const seen = (p: Proc, text: string, from = 0) => p.out.indexOf(text, from) >= 0
const sessionCount = () =>
	existsSync(`${home}/sessions`) ? readdirSync(`${home}/sessions`).filter((id) => existsSync(`${home}/sessions/${id}/session.ason`)).length : 0

test('a conversation streams, cancels on Escape and survives a restart', async () => {
	let p = run()
	await until('a session', () => sessionCount() === 1)
	type(p, 'first\r')
	await until('the answer', () => seen(p, 'ECHO(first)'))

	type(p, 'hold on\r')
	await until('streaming output', () => seen(p, 'PART1'))
	// A lone ESC, as a terminal without the kitty protocol sends it.
	type(p, '\x1b')
	await until('the turn to be cancelled', () => seen(p, '[cancelled]'))
	await until('the request to be aborted', () => aborted === 1)

	let mark = p.out.length
	type(p, '\x12') // Ctrl-R
	await until('the conversation after restart', () => seen(p, 'ECHO(first)', mark) && seen(p, 'PART1', mark))
	expect(p.exit).toBeUndefined()
	type(p, 'second\r')
	await until('an answer after restart', () => seen(p, 'ECHO(second)'))
	// The model got the whole conversation back, cut-off turn included.
	let texts = requests.at(-1)!.flatMap((m) => m.content.map((b: any) => b.text))
	expect(texts).toEqual(expect.arrayContaining(['first', 'ECHO(first)', 'hold on', 'PART1', 'second']))
	expect(sessionCount()).toBe(1)

	type(p, '\x03') // Ctrl-C
	await until('quit', () => p.exit !== undefined)
	expect(p.exit).toBe(0)
}, 30_000)

test('a second ./run follows the same stream and takes over when the host quits', async () => {
	let a = run()
	await until('a session', () => sessionCount() === 1)
	type(a, 'hold this\r')
	await until('streaming output', () => seen(a, 'PART1'))

	let b = run()
	await until('the second to see the running turn', () => seen(b, 'PART1'))
	holds[0]!()
	await until('both to see the rest of the stream', () => seen(a, 'PART2') && seen(b, 'PART2'))

	type(a, '\x03')
	await until('the host to quit', () => a.exit !== undefined)
	expect(a.exit).toBe(0)
	// Nobody else is left to answer: b must now be host.
	type(b, 'after\r')
	await until('an answer through the new host', () => seen(b, 'ECHO(after)'))
	expect(b.exit).toBeUndefined()
	expect(sessionCount()).toBe(1)
}, 30_000)

test('a host restarted mid-turn records it interrupted and everyone rejoins', async () => {
	let a = run()
	await until('a session', () => sessionCount() === 1)
	let b = run()
	type(a, 'hold it\r')
	await until('both to see the stream', () => seen(a, 'PART1') && seen(b, 'PART1'))

	let markA = a.out.length
	let markB = b.out.length
	type(a, '\x12') // Ctrl-R in the host, while the turn runs
	await until('the dead host to drop its request', () => aborted === 1)
	// The cut-off turn, streamed text included, is in history as
	// interrupted: the survivor sees it (repainting only what changed),
	// and so does the restarted host, which paints it all afresh.
	await until('the survivor to show the interrupted turn', () => seen(b, '[interrupted]', markB))
	await until('the restarted process to rejoin', () => seen(a, '[interrupted]', markA) && seen(a, 'PART1', markA))
	expect(a.exit).toBeUndefined()
	expect(b.exit).toBeUndefined()

	type(b, 'from b\r')
	await until('an answer to b', () => seen(b, 'ECHO(from b)') && seen(a, 'ECHO(from b)'))
	type(a, 'from a\r')
	await until('an answer to a', () => seen(a, 'ECHO(from a)') && seen(b, 'ECHO(from a)'))
	// The model got the cut-off text back; nothing was sent twice.
	let texts = requests.at(-1)!.flatMap((m) => m.content.map((b: any) => b.text))
	expect(texts).toEqual(['hold it', 'PART1', 'from b', 'ECHO(from b)', 'from a'])

	let [id] = readdirSync(`${home}/sessions`)
	let ends = readFileSync(`${home}/sessions/${id}/history.asonl`, 'utf8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => ason.parse(l) as any)
		.filter((r) => r.type === 'turn_end')
		.map((r) => r.status)
	expect(ends).toEqual(['interrupted', 'completed', 'completed'])
	expect(sessionCount()).toBe(1)
}, 30_000)

test('the model reads a file through the host and answers from it', async () => {
	let p = run()
	await until('a session', () => sessionCount() === 1)
	type(p, 'read run\r')
	await until('the answer from the file', () => seen(p, 'SAW(#!/usr/bin/env bash)'))
	expect(requests).toHaveLength(2)
	expect(requests[1]!.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
}, 30_000)
