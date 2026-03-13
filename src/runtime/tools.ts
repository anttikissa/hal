// Tools — registry + execution facade for the agent loop.

import { homedir } from 'os'
import { bash } from '../tools/bash.ts'
import { read } from '../tools/read.ts'
import { write } from '../tools/write.ts'
import { edit } from '../tools/edit.ts'
import { readBlob } from '../tools/read-blob.ts'
import { grep } from '../tools/grep.ts'
import { glob } from '../tools/glob.ts'
import { ls } from '../tools/ls.ts'
import { evalModule } from '../tools/eval.ts'
import { ask } from '../tools/ask.ts'
import type { ToolModule, ToolContext } from '../tools/tool.ts'

const HOME = homedir()
const CWD = process.env.LAUNCH_CWD ?? process.cwd()

const ALWAYS_TOOLS: ToolModule[] = [bash, read, write, edit, grep, readBlob, glob, ls, ask]
const ALL_TOOLS: ToolModule[] = [...ALWAYS_TOOLS, evalModule]
const TOOL_BY_NAME = new Map(ALL_TOOLS.map(t => [t.definition.name, t]))

const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }

export const toolsConfig = {
	maxOutput: 50_000,
	contextLines: 3,
}

function shortenHome(text: string): string {
	if (!HOME) return text
	return text.replaceAll(HOME, '~')
}

export function truncate(s: string, max = toolsConfig.maxOutput): string {
	if (s.length <= max) return s
	return s.slice(0, max) + `\n[truncated ${s.length - max} chars]`
}

export function getTools(evalEnabled: boolean): any[] {
	const defs = ALWAYS_TOOLS.map(t => t.definition)
	if (evalEnabled) defs.push(evalModule.definition)
	return [...defs, WEB_SEARCH_TOOL]
}

/** TOOLS is the static base set (used for backwards compat). Prefer getTools(). */
export const TOOLS = ALWAYS_TOOLS.map(t => t.definition)

export interface ToolCall {
	id: string
	name: string
	input: unknown
}

type OnChunk = (text: string) => Promise<void>

export interface ToolExecContext {
	evalCtx?: unknown
	sessionId?: string
	signal?: AbortSignal
	cwd?: string
}

export function argsPreview(call: ToolCall): string {
	const tool = TOOL_BY_NAME.get(call.name)
	return shortenHome(tool ? tool.argsPreview(call.input) : call.name)
}

export async function executeTool(call: ToolCall, onChunk?: OnChunk, ctx?: ToolExecContext): Promise<string | any[]> {
	const result = await _executeTool(call, onChunk, ctx)
	return typeof result === 'string' ? shortenHome(result) : result
}

function buildToolContext(ctx?: ToolExecContext): ToolContext {
	return {
		cwd: ctx?.cwd ?? CWD,
		sessionId: ctx?.sessionId,
		signal: ctx?.signal,
		contextLines: toolsConfig.contextLines,
		truncate,
		evalCtx: ctx?.evalCtx,
	}
}

function validateRequired(call: ToolCall): string | null {
	const def = TOOL_BY_NAME.get(call.name)?.definition
	if (!def) return null
	const required: string[] = (def.input_schema?.required as string[]) ?? []
	const inp = call.input as any
	const missing = required.filter((key: string) => inp?.[key] == null)
	if (missing.length) return `error: ${call.name} requires ${missing.join(', ')}`
	return null
}

async function _executeTool(call: ToolCall, onChunk?: OnChunk, ctx?: ToolExecContext): Promise<string | any[]> {
	const err = validateRequired(call)
	if (err) return err
	const tool = TOOL_BY_NAME.get(call.name)
	if (tool) return tool.execute(call.input, buildToolContext(ctx), onChunk)
	return `Unknown tool: ${call.name}`
}

export const tools = { config: toolsConfig, truncate, shortenHome, getTools, argsPreview, executeTool }
