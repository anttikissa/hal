// Tool call hooks — transforms applied before display and execution.
// Hal edits this file to add/remove hooks as needed.

import type { ToolCall } from './tools.ts'
import { resolve, isAbsolute } from 'path'
import { homedir } from 'os'

const HOME = homedir()
const RAW_CWD = process.env.LAUNCH_CWD ?? process.cwd()
const CWD = RAW_CWD.startsWith('~/') ? HOME + RAW_CWD.slice(1) : resolve(RAW_CWD)

function resolvePath(p: string): string {
	if (p.startsWith('~/')) p = HOME + p.slice(1)
	return isAbsolute(p) ? p : resolve(CWD, p)
}

/** Strip redundant "cd $CWD && " prefix from bash commands. */
function stripCdCwd(call: ToolCall): ToolCall {
	if (call.name !== 'bash') return call
	const inp = call.input as any
	const cmd = String(inp?.command ?? '')
	const m = cmd.match(/^cd\s+(\S+)\s*&&\s*/)
	if (m && resolvePath(m[1]) === CWD) {
		return { ...call, input: { ...inp, command: cmd.slice(m[0].length) } }
	}
	return call
}

const hooks: Array<(call: ToolCall) => ToolCall> = [
	stripCdCwd,
]

export function runHooks(call: ToolCall): ToolCall {
	for (const hook of hooks) call = hook(call)
	return call
}
