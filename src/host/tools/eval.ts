// Lets the model run JavaScript/TypeScript and chain tool calls in code
// (task v99): only the returned value enters context. The code runs in a
// child process (eval-child.ts), so it can never block the host's event
// loop; tool() and host() are requests this module answers.
import { ason } from '../../common/ason.ts'
import { approval } from '../approval.ts'
import { history } from '../history.ts'
import { jobs } from '../jobs.ts'
import { nativeTool } from '../native-tool.ts'
import { slash } from '../slash.ts'
import { tools, type Tool, type ToolContext } from '../tools.ts'

// Configuration: true puts the whole help in the system prompt; false
// lists only the summary under Other tools (HELP <TOOL> shows the rest).
const inPrompt = false
const summary = 'run async JavaScript/TypeScript in a child process; tool() chains Hal tools'
const help = String.raw`## EVAL

Run JavaScript/TypeScript in a child process of Hal. The code goes between !!START and !!END lines.
EVAL /* <purpose> */
!!START
<code>
!!END
- A single expression returns its value; otherwise write a function body and return the result. Top-level await works.
- await tool('READ "a.ts"') runs a Hal tool (MCP included) and returns its text output. Chain tools in code when one result decides the next calls or raw output is large: only your return value and console.* output enter context. Example:
EVAL /* Find host TODO files */
!!START
let files = (await tool('GREP "TODO" { files: true }')).split("\n")
return files.filter(f => f.startsWith("src/host"))
!!END
- await host((a, b) => ..., a, b) runs a function inside the Hal host, for its live state, and returns its value. The function sees only its arguments, ctx and tool, and imports Hal modules with await import("hal/host/tools.ts"). It blocks all of Hal while it runs synchronously: keep it short.
- ctx has cwd, sessionId and callId. Aborting the call kills the process and everything it started. Timers left running keep the process alive after the call returns, as a background job: STOP t<number> stops it.`

const parameters = {
	type: 'object',
	properties: { code: { type: 'string' }, description: { type: 'string' } },
	required: ['code'],
}

const syntax = { usage: ['EVAL', '!!START', '<code>', '!!END'], block: 'code', resolve }

const childPath = `${import.meta.dir}/../eval-child.ts`

type Request = { t: 'tool'; id: number; cmd: string } | { t: 'host'; id: number; source: string; args: unknown[] }
type Message = Request | { t: 'done'; text: string } | { t: 'fail'; text: string } | { t: 'notice'; text: string }

// Runs one Hal tool from its call text, with the tool's own checks; a call
// that would ask the user for approval is refused instead.
function toolFn(ctx: ToolContext) {
	return async (cmd: string): Promise<string> => {
		let call = { type: 'tool_call' as const, id: crypto.randomUUID(), ...nativeTool.resolve(cmd, ctx), cmd }
		if (approval.form(call)) throw new Error(`needs approval; call it directly instead: ${cmd}`)
		let result = await tools.run(call, ctx)
		if (result.isError) throw new Error(result.output)
		return result.output
	}
}

// host(fn, ...args): the function's source runs here, in the host.
async function inHost(source: string, args: unknown[], ctx: ToolContext): Promise<unknown> {
	let fn = new Function('ctx', 'tool', `return (${source})`)(ctx, toolFn(ctx))
	return await fn(...args)
}

function answer(request: Request, ctx: ToolContext): Promise<unknown> {
	return request.t === 'tool' ? toolFn(ctx)(request.cmd) : inHost(request.source, request.args, ctx)
}

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	if (typeof input.code !== 'string' || !input.code.trim()) throw new Error('EVAL needs code')
	let result = Promise.withResolvers<string>()
	let settled = false
	let proc = Bun.spawn([process.execPath, childPath], {
		cwd: ctx.cwd,
		detached: true,
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'pipe',
		serialization: 'advanced',
		ipc: (message: Message) => receive(message),
	})
	let stderr = new Response(proc.stderr).text()

	// The process may have exited by the time an answer is ready.
	function send(message: Record<string, unknown>) {
		try {
			proc.send(message)
		} catch {}
	}
	// A value that cannot be cloned crosses as its inspected text.
	function reply(id: number, value: unknown) {
		try {
			proc.send({ t: 'reply', id, value })
		} catch {
			send({ t: 'reply', id, value: Bun.inspect(value) })
		}
	}
	function settle(error: boolean, text: string) {
		if (settled) return
		settled = true
		ctx.signal.removeEventListener('abort', abort)
		if (error) result.reject(new Error(text))
		else result.resolve(text)
	}
	// Its own process group, as for BASH: processes the code started die too.
	function kill() {
		try {
			process.kill(-proc.pid, 'SIGKILL')
		} catch {}
	}
	// Timers the code left keep its process alive after the call returns,
	// as a background job that STOP, /kill, closing the tab and Hal exiting
	// stop. A call without a card cannot be named, so its process dies.
	function linger() {
		let n = ctx.callId === undefined ? undefined : history.callNumber(ctx.sessionId, ctx.callId)
		if (n === undefined) return kill()
		let id = `${ctx.sessionId}:${n}`
		jobs.state.running.set(id, { sessionId: ctx.sessionId, stop: kill })
		void proc.exited.then(() => jobs.drop(id))
	}
	function receive(message: Message) {
		if (message.t === 'done' || message.t === 'fail') {
			if (!settled) linger()
			return settle(message.t === 'fail', message.text)
		}
		if (message.t === 'notice') {
			history.append(ctx.sessionId, { type: 'notice', text: message.text })
			return slash.output(ctx.sessionId, message.text, true)
		}
		answer(message, ctx).then(
			(value) => reply(message.id, value),
			(e) => send({ t: 'reply', id: message.id, error: e instanceof Error ? (e.stack ?? String(e)) : Bun.inspect(e) }),
		)
	}
	function abort() {
		kill()
		settle(true, 'EVAL aborted')
	}

	if (ctx.signal.aborted) abort()
	else ctx.signal.addEventListener('abort', abort)
	send({ t: 'run', code: input.code, ctx: { cwd: ctx.cwd, sessionId: ctx.sessionId, callId: ctx.callId } })
	void proc.exited.then(async (code) => settle(true, `EVAL process exited with code ${code}\n${await stderr}`.trim()))
	return result.promise
}

// The code is the literal text after leading /* purpose */ comments, so
// nothing needs quoting (task 0nt). One whole string literal or { code }
// is accepted too.
function resolve(raw: string): { name: string; input: Record<string, unknown> } {
	let purposes: string[] = []
	let text = raw.replace(/^(\s*\/\*([\s\S]*?)\*\/)*\s*/, (head) => {
		for (let m of head.matchAll(/\/\*([\s\S]*?)\*\//g)) purposes.push(m[1]!.trim())
		return ''
	})
	let description = purposes.filter(Boolean).join(' ')
	let code = text.trimEnd()
	if ('{\'"`'.includes(code[0] ?? ''))
		try {
			let { value, end } = ason.parseAt(code, 0)
			if (end === code.length && typeof value === 'string') code = value
			else if (end === code.length && value && typeof value === 'object')
				return { name: 'eval', input: nativeTool.generic(tool, raw) }
		} catch {}
	return { name: 'eval', input: { code, ...(description && { description }) } }
}

export const tool: Tool = {
	name: 'eval',
	inPrompt,
	summary,
	help,
	parameters,
	syntax,
	card: { command: 'code', language: 'typescript' },
	run,
}
