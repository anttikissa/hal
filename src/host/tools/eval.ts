// Lets the model run JavaScript/TypeScript inside the running host, to
// inspect live state or chain tool calls in code (task v99): only the
// returned value enters context.
import { ason } from '../../common/ason.ts'
import { approval } from '../approval.ts'
import { history } from '../history.ts'
import { nativeTool } from '../native-tool.ts'
import { slash } from '../slash.ts'
import { tools, type Tool, type ToolContext } from '../tools.ts'

// Configuration: true puts the whole help in the system prompt; false
// lists only the summary under Other tools (HELP <TOOL> shows the rest).
const inPrompt = false
const summary = 'run async JavaScript/TypeScript in the Hal host; tool() chains Hal tools'
const help = String.raw`## EVAL

Run JavaScript/TypeScript inside the running Hal host process. The code goes between !!START and !!END lines, literally: no quoting or escaping.
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
- Import Hal modules with await import("hal/host/tools.ts"). ctx has cwd, sessionId and signal.
- Synchronous code freezes all of Hal: keep it under 100 ms. Await tools and I/O; avoid spawnSync, execSync, *Sync file calls and busy-waits. Looping over fewer than 1,000 items is fine; for more, await between chunks or use BASH. Wait with await new Promise(r => setTimeout(r, ms)).`

const parameters = {
	type: 'object',
	properties: { code: { type: 'string' }, description: { type: 'string' } },
	required: ['code'],
}

const syntax = { usage: ['EVAL', '!!START', '<code>', '!!END'], block: 'code', resolve }

const transpiler = new Bun.Transpiler({ loader: 'ts', deadCodeElimination: false })

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

// The host's real console would write over the UI; collect output instead.
function capture(logs: string[]) {
	let log = (...args: unknown[]) => void logs.push(args.map(show).join(' '))
	return { log, info: log, warn: log, error: log, debug: log, dir: log }
}

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

// Timers whose callbacks fail after the call has returned report a notice.
function timers(ctx: ToolContext) {
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
				let text = `Eval ${ctx.callId ?? ''} ${repeat ? 'interval stopped' : 'timeout failed'}: ${e instanceof Error ? (e.stack ?? String(e)) : show(e)}`
				history.append(ctx.sessionId, { type: 'notice', text })
				slash.output(ctx.sessionId, text, true)
			}
		}
		return timer
	}
	return [schedule.bind(null, false), schedule.bind(null, true)]
}

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	if (typeof input.code !== 'string' || !input.code.trim()) throw new Error('EVAL needs code')
	let logs: string[] = []
	let js = compile(input.code).trim().replace(/;$/, '')
	let fn = new Function('console', 'ctx', 'tool', 'setTimeout', 'setInterval', `return ${js}`)(
		capture(logs),
		ctx,
		toolFn(ctx),
		...timers(ctx),
	)
	try {
		let value = await fn()
		if (value !== undefined) logs.push(show(value))
		return logs.join('\n') || 'undefined'
	} catch (e) {
		logs.push(e instanceof Error ? (e.stack ?? String(e)) : `Thrown: ${show(e)}`)
		throw new Error(logs.join('\n'))
	}
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
