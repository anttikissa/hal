// Local tools the model may call. The host runs them between provider
// rounds of one turn (host.ts); each call gets exactly one result, and
// no result is larger than tools.maxChars(). Tool input comes from the
// model, so it is checked like any untrusted data.
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
import type { ToolDef } from './provider.ts'

// `sessionId`: the session whose turn runs the call. `endTurn`: the
// turn ends once this round's results are in, unless messages wait to
// be read (the wait tool).
export type ToolContext = { cwd: string; signal: AbortSignal; sessionId: string; endTurn?: () => void }

// One file per tool in src/host/tools/, named like it (read.ts is
// read), exporting `tool`, so adding a tool touches nothing else.
// `parameters` is the input's JSON schema. `readOnly`: running it
// changes nothing, so an edited prompt may replace the turn that ran it
// (prompts.amend). run returns the output; throwing makes an error
// result with the message.
export type Tool = {
	name: string
	description: string
	parameters: ToolDef['inputSchema']
	readOnly?: true
	run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

function dir(): string {
	return `${import.meta.dir}/tools`
}

// Every tool by name, sorted, read from the directory each time.
function all(): Map<string, Tool> {
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
		result = { type: 'tool_result', id: call.id, output: await tool.run(call.input, ctx) }
	} catch (e: any) {
		result = { type: 'tool_result', id: call.id, output: `Error: ${e?.message ?? e}`, isError: true }
	}
	result.output = tools.cap(result.output)
	return result
}

// Output cut to tools.maxChars(), saying how much was left out.
function cap(output: string): string {
	let max = tools.maxChars()
	return output.length > max ? `${output.slice(0, max)}\n[output truncated: ${output.length - max} more characters]` : output
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
