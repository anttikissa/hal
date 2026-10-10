// End to end: real ./run processes on a temp home with fake credentials,
// talking to a fake Anthropic server. The home's local.ts stands a pipe
// in for the tty (stdin in, frames out) and points anthropic at the fake,
// so neither the real auth.ason nor the real API is touched.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
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

// "bash <command>" asks for the bash tool; a tool result is answered
// with SAW(<its first line>).
const bashUse = (command: string) => [
	sseEvent({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
	sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_b', name: 'bash', input: {} } }),
	sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'Run it' }) } }),
	sseEvent({ type: 'content_block_stop', index: 0 }),
	sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }),
	sseEvent({ type: 'message_stop' }),
]
const toolAnswer = (result: any) => [
	sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
	textDelta(`SAW(${String(result.content).split('\n')[0]})`),
	...finish,
]

// A prompt's own text, without the [HH:MM] line and host notes that
// replay puts in front of it.
const bare = (text: string) => text.replace(/^\[[\d -]+:\d\d[^\]\n]*\]\n/, '')

// Answers "<prompt>" with "ECHO(<prompt>)". A prompt starting with
// "hold" streams PART1, then waits for release() to send PART2 and
// finish, or for the client to abort.
function reply(req: Request, body: any): Response {
	let messages = body.messages
	requests.push(messages)
	let lastBlock = messages.flatMap((m: any) => m.role === 'user' ? m.content : []).findLast((b: any) => b.type !== 'text' || !b.text.startsWith('<hal-note>'))
	if (lastBlock.type === 'tool_result') return sse([sseEvent({ type: 'message_start', message: { usage: { input_tokens: 5 } } }), ...toolAnswer(lastBlock)])
	let prompt: string = bare(lastBlock.text)
	if (prompt.startsWith('bash ')) return sse(bashUse(prompt.slice(5)))
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
	mkdirSync(`${home}/secrets`)
	server = Bun.serve({ port: 0, idleTimeout: 0, fetch: async (req) => reply(req, await req.json()) })
	writeFileSync(`${home}/secrets/auth.ason`, ason.stringify({ anthropic: { apiKey: 'fake-key' } }) + '\n', { mode: 0o600 })
	// Provider tests exercise an already-set-up home; a fresh first tab is hal/intro.
	mkdirSync(`${home}/sessions/1-ready`, { recursive: true })
	mkdirSync(`${home}/state`)
	writeFileSync(`${home}/sessions/1-ready/session.ason`, ason.stringify({ id: '1-ready', cwd: `${import.meta.dir}/..`, model: 'anthropic/claude-opus-5-5', createdAt: new Date().toISOString() }) + '\n')
	writeFileSync(`${home}/state/tabs.ason`, ason.stringify({ open: ['1-ready'], closed: [], attention: [] }) + '\n')
	writeFileSync(
		`${home}/local.ts`,
		`import { terminal } from ${JSON.stringify(`${import.meta.dir}/client/terminal.ts`)}
import { anthropic } from ${JSON.stringify(`${import.meta.dir}/host/anthropic.ts`)}
import { web } from ${JSON.stringify(`${import.meta.dir}/host/web.ts`)}
web.port = () => 0
terminal.available = () => true
terminal.realIO = () => ({
	setRawMode() {},
	onData(fn) { process.stdin.on('data', fn); process.stdin.on('end', () => process.exit(0)); process.stdin.resume() },
	write: (s) => process.stdout.write(s),
	exit: (code) => process.exit(code),
	stop() {},
	onContinue() {},
	onExit(fn) { process.on('exit', fn) },
	size: () => ({ rows: 40, cols: 200 }),
	onResize() {},
})
anthropic.apiUrl = 'http://127.0.0.1:${server.port}/v1/messages'
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
		// SIGKILL skips ./run's trap, so its tab file goes in the home.
		env: { ...process.env, HAL_HOME: home, TMPDIR: home },
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
const hostReady = () => existsSync(`${home}/state/host.sock`)

// Every turn end in the one session's history: its status.
function ends(): string[] {
	let [id] = readdirSync(`${home}/sessions`)
	return readFileSync(`${home}/sessions/${id}/history.asonl`, 'utf8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => ason.parse(l) as any)
		.filter((r) => r.type === 'turn_end')
		.map((r) => r.status)
}

const continued = 'completed work.'

test('Escape pauses a turn; it stays paused over a restart and Enter continues it', async () => {
	let p = run()
	await until('the seeded tab to be shown', () => seen(p, '1-ready'))
	type(p, 'first\r')
	await until('the answer', () => seen(p, 'ECHO(first)'))

	type(p, 'hold on\r')
	await until('streaming output', () => seen(p, 'PART1'))
	// A lone ESC, as a terminal without the kitty protocol sends it.
	type(p, '\x1b')
	await until('the turn to be paused', () => seen(p, 'Paused.'))
	await until('the request to be aborted', () => aborted === 1)

	let mark = p.out.length
	type(p, '\x12') // Ctrl-R
	await until('the conversation after restart', () => seen(p, 'ECHO(first)', mark) && seen(p, 'PART1', mark) && seen(p, ': continue', mark))
	expect(p.exit).toBeUndefined()
	await Bun.sleep(200)
	expect(requests).toHaveLength(2)
	type(p, '\r')
	await until('the paused turn to continue', () => seen(p, continued, mark))
	type(p, 'second\r')
	await until('an answer after restart', () => seen(p, 'ECHO(second)'))
	// The model got the whole conversation back, cut-off turn included.
	let texts = requests.at(-1)!.flatMap((m) => m.content.map((b: any) => b.text && bare(b.text)))
	expect(texts).toEqual(expect.arrayContaining(['first', 'ECHO(first)', 'hold on', 'PART1', 'second']))
	expect(ends()).toEqual(['completed', 'paused', 'completed', 'completed'])
	expect(sessionCount()).toBe(1)

	type(p, '\x03') // Ctrl-C
	await until('quit', () => p.exit !== undefined)
	expect(p.exit).toBe(0)
}, 30_000)

test('a second ./run follows the same stream and carries the turn on when the host quits', async () => {
	let a = run()
	await until('the seeded tab to be shown', () => seen(a, '1-ready'))
	type(a, 'hold this\r')
	await until('streaming output', () => seen(a, 'PART1'))

	let b = run()
	await until('the second to see the running turn', () => seen(b, 'PART1'))
	type(a, '\x03')
	await until('the host to quit', () => a.exit !== undefined)
	expect(a.exit).toBe(0)
	// Another Hal process remains: nothing pauses, b continues the turn.
	await until('the new host to continue the turn', () => seen(b, continued))
	expect(requests).toHaveLength(2)
	type(b, 'after\r')
	await until('an answer through the new host', () => seen(b, 'ECHO(after)'))
	expect(ends()).toEqual(['completed', 'completed'])
	expect(b.exit).toBeUndefined()
	expect(sessionCount()).toBe(1)
}, 30_000)

// Also the one check that a host exits when its controller closes stdin:
// a runner that dies before afterEach must not leave orphaned hosts on
// deleted temp homes (task ah).
test('Ctrl-C of the last Hal process kills its command and pauses the turn; the next start leaves it paused', async () => {
	let marker = `32.${process.pid}3`
	let alive = () => Bun.spawnSync(['pgrep', '-f', `sleep ${marker}`]).stdout.toString().trim() !== ''
	let a = run()
	await until('the seeded tab to be shown', () => seen(a, '1-ready'))
	type(a, `bash sleep ${marker} & sleep ${marker}\r`)
	await until('the command to run', alive)
	type(a, '\x03')
	await until('quit', () => a.exit !== undefined)
	await until('no sleep left', () => !alive())
	expect(ends()).toEqual(['paused'])

	let b = run()
	await until('the paused turn', () => seen(b, ': continue'))
	await Bun.sleep(200)
	expect(requests).toHaveLength(1)
	b.sub.stdin.end()
	await until('the host to exit after stdin EOF', () => b.exit !== undefined)
	expect(b.exit).toBe(0)
}, 30_000)

test('a restarted host kills its running command; the next host continues the turn', async () => {
	let marker = `34.${process.pid}5`
	let alive = () => Bun.spawnSync(['pgrep', '-f', `sleep ${marker}`]).stdout.toString().trim() !== ''
	let a = run()
	await until('the first host', hostReady)
	let peer = run() // a second Hal process, so the restart pauses nothing
	await until('the joining peer', () => seen(peer, 'peer'))
	type(a, `bash sleep ${marker} & sleep ${marker}\r`)
	await until('the command to run', alive)
	type(a, '\x12') // Ctrl-R: not the last Hal process, so nothing pauses
	await until('no sleep left', () => !alive())
	await until('the turn to end', () => ends().length === 1)
	expect(ends()).toEqual(['completed'])
}, 30_000)

test('a host restarted mid-turn continues it, and everyone rejoins', async () => {
	let a = run()
	await until('the first host', hostReady)
	let b = run()
	await until('the joining peer', () => seen(b, 'peer'))
	type(a, 'hold it\r')
	await until('both to see the stream', () => seen(a, 'PART1') && seen(b, 'PART1'))

	let markA = a.out.length
	type(a, '\x12') // Ctrl-R in the host, while the turn runs
	await until('the dead host to drop its request', () => aborted === 1)
	// Whoever is host now continues the turn, streamed text included.
	await until('both to see the turn continue', () => seen(b, continued) && seen(a, continued, markA))
	expect(a.exit).toBeUndefined()
	expect(b.exit).toBeUndefined()

	type(b, 'from b\r')
	await until('an answer to b', () => seen(b, 'ECHO(from b)') && seen(a, 'ECHO(from b)'))
	type(a, 'from a\r')
	await until('an answer to a', () => seen(a, 'ECHO(from a)') && seen(b, 'ECHO(from a)'))
	// The model got the cut-off text back, was told, and nothing was sent twice.
	expect(requests).toHaveLength(4)
	let texts = requests.at(-1)!.flatMap((m) => m.content.map((b: any) => b.text && bare(b.text)))
	expect(texts.filter((t: string) => !t.startsWith('<hal-note>') && !t.startsWith('ECHO(<hal-note>'))).toEqual(['hold it', 'PART1', 'from b', 'ECHO(from b)', 'from a'])
	expect(ends()).toEqual(['completed', 'completed', 'completed'])
	expect(sessionCount()).toBe(1)
}, 30_000)
