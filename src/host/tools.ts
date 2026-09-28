// Local tools the model may call. Calls run in order (turns.ts).
// Long results stay in session blobs; the model sees their head and tail.
//
// A call is recorded before it runs and its result after, so a host
// that dies in between never runs it again; replay tells the model it
// may or may not have run. That is what makes bash, which mutates,
// safe to offer.
//
// Calls run one after another in call order (turns.ts), never in
// parallel: a later call may rely on an earlier one (spawn, then wait).

import { spawn } from 'child_process'
import { readdirSync } from 'fs'
import type { ToolCallBlock, ToolResultBlock } from '../common/blocks.ts'
import { blobs } from './blobs.ts'
import type { ToolDef } from './provider.ts'

// `sessionId`: the session whose turn runs the call. `endTurn`: the
// turn ends once this round's results are in, unless messages wait to
// be read (the wait tool).
export type ToolContext = { cwd: string; signal: AbortSignal; sessionId: string; endTurn?: () => void }
export type ToolOutput = string | { text: string; image: { mediaType: string; data: string } }

// One file per tool in src/host/tools/, named like it (read.ts is
// read), exporting `tool`, so adding a tool touches nothing else.
// `parameters` is the input's JSON schema. `readOnly`: running it
// changes nothing, so an edited prompt may replace the turn that ran it
// (prompts.amend). run returns the output; throwing makes an error
// result with the message.
export type Tool<Output = string> = {
	name: string
	description: string
	parameters: ToolDef['inputSchema']
	readOnly?: true
	run(input: Record<string, unknown>, ctx: ToolContext): Promise<Output>
}

function dir(): string {
	return `${import.meta.dir}/tools`
}

// Every tool by name, sorted, read from the directory each time.
function all(): Map<string, Tool<ToolOutput>> {
	let found = new Map<string, Tool>()
	for (let file of readdirSync(tools.dir()).sort()) {
		if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
		let tool: Tool = require(`${tools.dir()}/${file}`).tool
		if (tool.name !== file.slice(0, -3)) throw new Error(`${tools.dir()}/${file} defines tool '${tool.name}'`)
		found.set(tool.name, tool)
	}
	return found
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

// Runs one call. Never throws: unknown tools, bad input and failures
// become error results.
async function run(call: ToolCallBlock, ctx: ToolContext): Promise<ToolResultBlock> {
	let result: ToolResultBlock
	try {
		let tool = tools.all().get(call.name)
		if (!tool) throw new Error(`unknown tool '${call.name}'`)
		let out = await tool.run(call.input, ctx)
		if (typeof out === 'string') result = { type: 'tool_result', id: call.id, output: out }
		else {
			let image = blobs.store(ctx.sessionId, out.image.mediaType, out.image.data)
			result = { type: 'tool_result', id: call.id, output: out.text, image: { type: 'image', blob: image.blob, mediaType: image.mediaType, bytes: image.bytes } }
		}
	} catch (e: any) {
		result = { type: 'tool_result', id: call.id, output: `Error: ${e?.message ?? e}`, isError: true }
	}
	result.output = call.name === 'read_blob' ? result.output : tools.cap(result.output, ctx.sessionId)
	return result
}

// Retain the whole result when cut, and show both ends: a bash failure
// usually says why at the end. Leave room for the recoverable reference.
function cap(output: string, sessionId?: string): string {
	let max = tools.maxChars()
	if (output.length <= max) return output
	let saved = sessionId && blobs.storeOutput(sessionId, output)
	let note = saved ? `\n[cut: ${Buffer.byteLength(output)} bytes total, whole output in blob ${saved.blob}; read_blob or cat ${saved.path}]` : `\n[output truncated: ${output.length - max} more characters]`
	let room = Math.max(0, max - note.length)
	let head = Math.ceil(room / 2)
	return `${output.slice(0, head)}${output.slice(-Math.floor(room / 2))}${note}`
}

// Stops a tool's process group: SIGTERM now, SIGKILL killAfterMs later
// for whatever ignored it (a background job outlives bash itself). The
// SIGKILL comes from a detached sh, so it still arrives when Hal exits
// first: quitting the last Hal process aborts every turn in its exit
// handler (host.ts).
function killGroup(pgid: number): void {
	try {
		process.kill(-pgid, 'SIGTERM')
	} catch {
		return
	}
	spawn('sh', ['-c', `sleep ${tools.killAfterMs() / 1000}; kill -9 -${pgid} 2>/dev/null`], { detached: true, stdio: 'ignore' }).unref()
}

export const tools = {
	dir,
	all,
	// Largest result handed to the model, in characters.
	maxChars: () => 50_000,
	maxLines: () => 2000,
	maxLineChars: () => 2000,
	// Larger files are refused rather than loaded whole.
	maxFileBytes: () => 20_000_000,
	// Unknown tools count as having side effects.
	readOnly: (name: string): boolean => tools.all().get(name)?.readOnly === true,
	defs: (): ToolDef[] => [...tools.all().values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
	killAfterMs: () => 2000,
	page,
	run,
	cap,
	killGroup,
}
