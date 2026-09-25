// Local tools the model may call. The host runs them between provider
// rounds of one turn (host.ts); each call gets exactly one result, and
// no result is larger than tools.maxChars(). Tool input comes from the
// model, so it is checked like any untrusted data.
//
// Only read-only tools for now: running one again (or not at all) after
// a crash is harmless.

import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import type { ToolCallBlock, ToolResultBlock } from '../common/blocks.ts'
import type { ToolDef } from './provider.ts'

export type ToolContext = { cwd: string; signal: AbortSignal }

// Returns the output; throwing makes an error result with the message.
export type Tool = { def: ToolDef; run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> }

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
	state: { tools: { read } as Record<string, Tool> },
	// Largest result handed to the model, in characters.
	maxChars: () => 50_000,
	maxLines: () => 2000,
	maxLineChars: () => 2000,
	// Larger files are refused rather than loaded whole.
	maxFileBytes: () => 20_000_000,
	defs: (): ToolDef[] => Object.values(tools.state.tools).map((t) => t.def),
	page,
	run,
}
