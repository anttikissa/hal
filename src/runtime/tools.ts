// Tools — definitions + execution for the agent loop.

import { statSync, readdirSync } from 'fs'
import { $ } from 'bun'
import { homedir } from 'os'
import { evalTool, type EvalContext } from './eval-tool.ts'
import { bash } from '../tools/bash.ts'
import { read } from '../tools/read.ts'
import { write } from '../tools/write.ts'
import { edit } from '../tools/edit.ts'
import { readBlob } from '../tools/read-blob.ts'
import { grep } from '../tools/grep.ts'
import { resolvePath as resolveToolPath } from '../tools/file-utils.ts'

const HOME = homedir()
const CWD = process.env.LAUNCH_CWD ?? process.cwd()

const CORE_TOOLS = [bash, read, write, edit, grep, readBlob] as const

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

const EVAL_TOOL = {
	name: 'eval',
	description: 'Execute TypeScript in the Hal process. Has access to runtime internals via ctx object (sessionId, halDir, stateDir, cwd). Use `~src/` prefix in imports to reference Hal source.',
	input_schema: {
		type: 'object',
		properties: {
			code: { type: 'string', description: 'TypeScript function body. `ctx` is in scope. Use `return` to return a value.' },
		},
		required: ['code'],
	},
}

const GLOB_TOOL = {
	name: 'glob',
	description: 'Find files by glob pattern. Returns matching file paths sorted by modification time.',
	input_schema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: "Glob pattern, e.g. '*.ts', 'src/**/*.tsx'" },
			path: { type: 'string', description: 'Directory to search in (default: cwd)' },
		},
		required: ['pattern'],
	},
}

const LS_TOOL = {
	name: 'ls',
	description: 'List directory contents as a tree. Ignores node_modules, .git, dist, etc.',
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Directory to list (default: cwd)' },
			depth: { type: 'integer', description: 'Max depth (default: 3)' },
		},
	},
}

const ASK_TOOL = {
	name: 'ask',
	description: 'Ask the user a question and wait for their response. Use this to clarify ambiguous instructions, gather preferences, or get decisions on implementation choices.',
	input_schema: {
		type: 'object',
		properties: {
			question: { type: 'string', description: 'The question to ask the user' },
		},
		required: ['question'],
	},
}

const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }

const BASE_TOOLS = [
	...CORE_TOOLS.map((tool) => tool.definition),
	GLOB_TOOL,
	LS_TOOL,
	WEB_SEARCH_TOOL,
	ASK_TOOL,
]

/** TOOLS is the static base set (used for backwards compat). Prefer getTools(). */
export const TOOLS = BASE_TOOLS

export function getTools(evalEnabled: boolean): any[] {
	return evalEnabled ? [...BASE_TOOLS, EVAL_TOOL] : BASE_TOOLS
}

function toolMap(tools: any[]) {
	return new Map(tools.map((tool) => [tool.name, tool]))
}

const BASE_MAP = toolMap(BASE_TOOLS)

function validateRequired(call: ToolCall): string | null {
	const tool = BASE_MAP.get(call.name) ?? (call.name === 'eval' ? EVAL_TOOL : null)
	if (!tool) return null
	const schema = (tool as any).input_schema
	const required: string[] = schema?.required ?? []
	const inp = call.input as any
	const missing = required.filter((key) => inp?.[key] == null)
	if (missing.length) return `error: ${call.name} requires ${missing.join(', ')}`
	return null
}

export interface ToolCall {
	id: string
	name: string
	input: unknown
}

type OnChunk = (text: string) => Promise<void>

export interface ToolExecContext {
	evalCtx?: EvalContext
	sessionId?: string
	signal?: AbortSignal
	cwd?: string
}

interface ResolvedToolExecContext extends ToolExecContext {
	cwd: string
}

type ExecuteHandler = (input: unknown, onChunk: OnChunk | undefined, ctx: ResolvedToolExecContext) => Promise<string | any[]> | string | any[]

const CORE_PREVIEW_HANDLERS: Array<[string, (input: unknown) => string]> = CORE_TOOLS.map((tool) => [
	tool.definition.name,
	(input: unknown) => tool.argsPreview(input),
])

const PREVIEW_HANDLERS = new Map<string, (input: unknown) => string>([
	...CORE_PREVIEW_HANDLERS,
	['glob', (input) => String((input as any)?.pattern ?? '')],
	['ls', (input) => String((input as any)?.path ?? '.')],
	['ask', (input) => String((input as any)?.question ?? '').slice(0, 80)],
	['eval', (input) => String((input as any)?.code ?? '').slice(0, 80)],
])

const EXEC_HANDLERS = new Map<string, ExecuteHandler>([
	['bash', (input, onChunk, ctx) => bash.execute(input, { cwd: ctx.cwd, signal: ctx.signal }, onChunk)],
	['read', (input, _onChunk, ctx) => read.execute(input, { cwd: ctx.cwd })],
	['write', (input, _onChunk, ctx) => write.execute(input, { cwd: ctx.cwd })],
	['edit', (input, _onChunk, ctx) => edit.execute(input, { cwd: ctx.cwd, contextLines: toolsConfig.contextLines })],
	['grep', (input, _onChunk, ctx) => grep.execute(input, { cwd: ctx.cwd })],
	['glob', executeGlob],
	['ls', executeLs],
	['read_blob', (input, _onChunk, ctx) => readBlob.execute(input, { sessionId: ctx.sessionId, truncate })],
	['eval', executeEval],
])

export function argsPreview(call: ToolCall): string {
	const preview = PREVIEW_HANDLERS.get(call.name)
	const text = preview ? preview(call.input) : call.name
	return shortenHome(text)
}

export async function executeTool(call: ToolCall, onChunk?: OnChunk, ctx?: ToolExecContext): Promise<string | any[]> {
	const result = await _executeTool(call, onChunk, ctx)
	return typeof result === 'string' ? shortenHome(result) : result
}

async function _executeTool(call: ToolCall, onChunk?: OnChunk, ctx?: ToolExecContext): Promise<string | any[]> {
	const err = validateRequired(call)
	if (err) return err
	const execute = EXEC_HANDLERS.get(call.name)
	if (!execute) return `Unknown tool: ${call.name}`
	return execute(call.input, onChunk, { ...ctx, cwd: ctx?.cwd ?? CWD })
}

async function executeGlob(input: unknown, _onChunk: OnChunk | undefined, ctx: ResolvedToolExecContext): Promise<string> {
	const inp = input as any
	const searchPath = resolveToolPath(inp?.path, ctx.cwd)
	const args = ['rg', '--files', '--hidden', '--no-ignore', '--sort=modified', '--glob', String(inp?.pattern ?? ''), searchPath]
	const result = await $`${args}`.quiet().nothrow()
	const raw = result.stdout.toString().trim()
	if (!raw) return 'No files found.'
	return raw
}

function executeLs(input: unknown, _onChunk: OnChunk | undefined, ctx: ResolvedToolExecContext): string {
	const inp = input as any
	const dir = resolveToolPath(inp?.path, ctx.cwd)
	const maxDepth = inp?.depth ?? 3
	const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage', 'target'])
	const lines: string[] = []

	function walk(d: string, prefix: string, depth: number) {
		if (depth > maxDepth || lines.length > 500) return
		let entries: string[]
		try {
			entries = readdirSync(d).sort()
		} catch {
			return
		}
		for (const entry of entries) {
			if (IGNORE.has(entry)) continue
			if (lines.length > 500) {
				lines.push(`${prefix}... (truncated)`)
				return
			}
			try {
				const full = `${d}/${entry}`
				if (statSync(full).isDirectory()) {
					lines.push(`${prefix}${entry}/`)
					walk(full, prefix + '  ', depth + 1)
				} else {
					lines.push(`${prefix}${entry}`)
				}
			} catch {}
		}
	}

	walk(dir, '', 0)
	return lines.join('\n') || '(empty directory)'
}

async function executeEval(input: unknown, _onChunk: OnChunk | undefined, ctx: ResolvedToolExecContext): Promise<string | any[]> {
	const evalCtx = ctx.evalCtx
	if (!evalCtx) return 'error: eval tool is not enabled (set eval: true in config.ason)'
	if (!evalCtx.runtime) {
		const { runtimeCore } = await import('./runtime.ts')
		try {
			evalCtx.runtime = runtimeCore.getRuntime()
		} catch {}
	}
	return await evalTool.executeEval(String((input as any).code), evalCtx)
}

export const tools = { config: toolsConfig, truncate, shortenHome, getTools, argsPreview, executeTool }
