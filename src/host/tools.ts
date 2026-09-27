// Local tools the model may call. The host runs them between provider
// rounds of one turn (host.ts); each call gets exactly one result, and
// no result is larger than tools.maxChars(). Tool input comes from the
// model, so it is checked like any untrusted data.
//
// A call is recorded before it runs and its result after, so a host
// that dies in between never runs it again; replay tells the model it
// may or may not have run. That is what makes bash, which mutates,
// safe to offer.

import { spawn } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import type { ToolCallBlock, ToolResultBlock } from '../common/blocks.ts'
import type { ToolDef } from './provider.ts'

export type ToolContext = { cwd: string; signal: AbortSignal }

// Returns the output; throwing makes an error result with the message.
// `readOnly`: running it changes nothing, so an edited prompt may
// replace the turn that ran it (prompts.amend).
export type Tool = { def: ToolDef; readOnly?: true; run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> }

function positive(input: Record<string, unknown>, key: string): number | undefined {
	let v = input[key]
	if (v === undefined) return undefined
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${key} must be a positive integer`)
	return v
}

// Lines offset..offset+limit-1 (1-based) of `text`, each at most
// maxLineChars, stopping early at maxChars. Says how to continue.
function page(text: string, offset = 1, limit = tools.maxLines()): string {
	let lines = text.split(/(?<=\n)/)
	if (offset > Math.max(lines.length, 1)) throw new Error(`offset ${offset} is past the end (${lines.length} lines)`)
	let out = ''
	let n = offset - 1
	let lineMax = tools.maxLineChars()
	for (; n < lines.length && n < offset - 1 + limit; n++) {
		let line = lines[n]!
		if (line.length > lineMax) line = `${line.slice(0, lineMax)}… [line cut: ${line.length - lineMax} more characters]\n`
		if (out.length + line.length > tools.maxChars() - 200 && n > offset - 1) break
		out += line
	}
	if (n < lines.length) out += `${out.endsWith('\n') ? '' : '\n'}[lines ${offset}-${n} of ${lines.length}; continue with offset ${n + 1}]`
	return out
}

const read: Tool = {
	readOnly: true,
	def: {
		name: 'read',
		description:
			'Read a text file, or list a directory. Relative paths start from the working directory. ' +
			'Long files come in pages; use offset (first line, 1-based) and limit (number of lines) to read on.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File or directory path' },
				offset: { type: 'integer', minimum: 1 },
				limit: { type: 'integer', minimum: 1 },
			},
			required: ['path'],
		},
	},
	async run(input, ctx) {
		if (typeof input.path !== 'string' || !input.path) throw new Error('path must be a non-empty string')
		let offset = positive(input, 'offset')
		let limit = positive(input, 'limit')
		let path = resolve(ctx.cwd, input.path.replace(/^~(?=\/|$)/, homedir()))
		let st = statSync(path)
		if (st.isDirectory()) {
			let entries = readdirSync(path, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
			return tools.page(entries.sort().map((e) => `${e}\n`).join(''), offset, limit)
		}
		if (st.size > tools.maxFileBytes()) throw new Error(`${input.path} is too large to read (${st.size} bytes)`)
		let bytes = await Bun.file(path).bytes()
		if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${input.path} looks like a binary file`)
		return tools.page(new TextDecoder().decode(bytes), offset, limit)
	},
}

const bash: Tool = {
	def: {
		name: 'bash',
		description:
			'Run a command with bash -c in the working directory. Returns the exit status and stdout and stderr combined. ' +
			'No stdin; long output is cut.',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The command to run' },
				description: {
					type: 'string',
					description: 'One short plain-language sentence for the user: what the command does and why, e.g. "Show the first 40 lines of the config"',
				},
			},
			required: ['command', 'description'],
		},
	},
	run(input, ctx) {
		if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command must be a non-empty string')
		if (typeof input.description !== 'string' || !input.description.trim()) throw new Error('description must be a non-empty sentence; the command did not run')
		if (ctx.signal.aborted) throw new Error('cancelled; the command did not run')
		// Its own process group, so cancel stops pipelines and children too.
		let child = spawn('bash', ['-c', `exec 2>&1\n${input.command}`], { cwd: ctx.cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
		let kill = () => {
			try {
				process.kill(-child.pid!, 'SIGKILL')
			} catch {}
		}
		ctx.signal.addEventListener('abort', kill, { once: true })
		// Keep only what can be shown; drain the rest so the command is not blocked.
		let out = ''
		child.stdout!.setEncoding('utf8').on('data', (d: string) => {
			if (out.length <= tools.maxChars()) out += d
		})
		return new Promise((done, fail) => {
			child.on('error', fail)
			child.on('close', (code, sig) => {
				ctx.signal.removeEventListener('abort', kill)
				let status = ctx.signal.aborted ? 'cancelled' : sig ? `killed by ${sig}` : `exit ${code}`
				done(`[${status}]\n${out}`)
			})
		})
	},
}

// Runs one call. Never throws: unknown tools, bad input and failures
// become error results.
async function run(call: ToolCallBlock, ctx: ToolContext): Promise<ToolResultBlock> {
	let tool = tools.state.tools[call.name]
	let result: ToolResultBlock
	try {
		if (!tool) throw new Error(`unknown tool '${call.name}'`)
		result = { type: 'tool_result', id: call.id, output: await tool.run(call.input, ctx) }
	} catch (e: any) {
		result = { type: 'tool_result', id: call.id, output: `Error: ${e?.message ?? e}`, isError: true }
	}
	let max = tools.maxChars()
	if (result.output.length > max) result.output = `${result.output.slice(0, max)}\n[output truncated: ${result.output.length - max} more characters]`
	return result
}

export const tools = {
	state: { tools: { read, bash } as Record<string, Tool> },
	// Largest result handed to the model, in characters.
	maxChars: () => 50_000,
	maxLines: () => 2000,
	maxLineChars: () => 2000,
	// Larger files are refused rather than loaded whole.
	maxFileBytes: () => 20_000_000,
	// Unknown tools count as having side effects.
	readOnly: (name: string): boolean => tools.state.tools[name]?.readOnly === true,
	defs: (): ToolDef[] => Object.values(tools.state.tools).map((t) => t.def),
	page,
	run,
}
