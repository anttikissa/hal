// Runs one EVAL's code in its own process, so the code can never block the
// host's event loop (task v99). tool() and host() are requests the host
// answers; console output and the result go back over IPC.

type Message =
	| { t: 'run'; code: string; ctx: Record<string, unknown> }
	| { t: 'reply'; id: number; value?: unknown; error?: string }

// More requests wait here, so a burst of calls cannot flood the host.
const maxInFlight = 64

const transpiler = new Bun.Transpiler({ loader: 'ts', deadCodeElimination: false })
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (e: Error) => void }>()
const waiting: (() => void)[] = []
let lastId = 0
let finished = false

// Code that parses as one expression returns its value; otherwise it is a
// function body that may `return`. Both may `await`.
function compile(code: string): string {
	try {
		return transpiler.transformSync(`(async () => (\n${code}\n))`)
	} catch {
		return transpiler.transformSync(`(async () => {\n${code}\n})`)
	}
}

function show(value: unknown): string {
	return typeof value === 'string' ? value : Bun.inspect(value)
}

function failure(e: unknown): string {
	return e instanceof Error ? (e.stack ?? String(e)) : `Thrown: ${show(e)}`
}

function send(message: Record<string, unknown>) {
	process.send!(message)
}

// The IPC channel keeps this process alive while the code runs or a request
// waits for its reply; afterwards only the code's own timers do.
function keepAlive() {
	if (finished && !pending.size && !waiting.length) process.channel!.unref()
	else process.channel!.ref()
}

function request(message: Record<string, unknown>): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let issue = () => {
			let id = ++lastId
			pending.set(id, { resolve, reject })
			send({ ...message, id })
		}
		if (pending.size < maxInFlight) issue()
		else waiting.push(issue)
		keepAlive()
	})
}

function reply(message: Extract<Message, { t: 'reply' }>) {
	let call = pending.get(message.id)
	if (!call) return
	pending.delete(message.id)
	waiting.shift()?.()
	keepAlive()
	if (message.error !== undefined) call.reject(new Error(message.error))
	else call.resolve(message.value)
}

function tool(cmd: string): Promise<string> {
	return request({ t: 'tool', cmd }) as Promise<string>
}

function host(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> {
	if (typeof fn !== 'function') throw new TypeError('host() takes a function')
	return request({ t: 'host', source: String(fn), args })
}

// The host's console is not ours to write to; collect output instead.
function capture(logs: string[]) {
	let log = (...args: unknown[]) => void logs.push(args.map(show).join(' '))
	return { log, info: log, warn: log, error: log, debug: log, dir: log }
}

// Timers whose callbacks fail after the call has returned report a notice.
function timers(callId: unknown) {
	function schedule(repeat: boolean, callback: (...args: unknown[]) => unknown, ms?: number, ...args: unknown[]) {
		let failed = false
		let timer = (repeat ? setInterval : setTimeout)(() => {
			if (failed) return
			void invoke()
		}, ms)
		async function invoke() {
			try {
				await callback(...args)
			} catch (e) {
				if (failed) return
				failed = true
				clearInterval(timer)
				send({
					t: 'notice',
					text: `Eval ${callId ?? ''} ${repeat ? 'interval stopped' : 'timeout failed'}: ${failure(e)}`,
				})
			}
		}
		return timer
	}
	return [schedule.bind(null, false), schedule.bind(null, true)]
}

async function run(code: string, ctx: Record<string, unknown>) {
	let logs: string[] = []
	try {
		let js = compile(code).trim().replace(/;$/, '')
		let fn = new Function('console', 'ctx', 'tool', 'host', 'setTimeout', 'setInterval', `return ${js}`)(
			capture(logs),
			ctx,
			tool,
			host,
			...timers(ctx.callId),
		)
		let value = await fn()
		if (value !== undefined) logs.push(show(value))
		send({ t: 'done', text: logs.join('\n') || 'undefined' })
	} catch (e) {
		logs.push(failure(e))
		send({ t: 'fail', text: logs.join('\n') })
	}
	finished = true
	keepAlive()
}

process.on('message', (message: Message) => {
	if (message.t === 'run') void run(message.code, message.ctx)
	else reply(message)
})
// The host is gone: nobody can read the result or answer requests.
process.on('disconnect', () => process.exit(0))
