// Tools — definitions + execution for the agent loop.

import { statSync, readdirSync } from 'fs'
import { $ } from 'bun'
import { homedir } from 'os'
import { ason } from '../utils/ason.ts'
import { blob } from '../session/blob.ts'
import { evalTool, type EvalContext } from './eval-tool.ts'
import { bash } from '../tools/bash.ts'
import { read } from '../tools/read.ts'
import { write } from '../tools/write.ts'
import { edit } from '../tools/edit.ts'
import { resolvePath as resolveToolPath } from '../tools/file-utils.ts'

const HOME = homedir()
const CWD = process.env.LAUNCH_CWD ?? process.cwd()

export const toolsConfig = {
	maxOutput: 50_000,
	contextLines: 3,
}

function shortenHome(text: string): string {
	if (!HOME) return text
	return text.replaceAll(HOME, '~')
}

function resolvePath(path?: string): string {
	return resolveToolPath(path, CWD)
}

export function truncate(s: string, max = toolsConfig.maxOutput): string {
	if (s.length <= max) return s
	return s.slice(0, max) + `\n[truncated ${s.length - max} chars]`
}

function blobPreview(blobId: string, blobData: any): string {
	if (blobData && typeof blobData === 'object' && typeof blobData.media_type === 'string' && typeof blobData.data === 'string') {
		return `blob ${blobId}\nkind: image\nmedia_type: ${blobData.media_type}\ndata: [base64 ${blobData.data.length} chars]`
	}
	return truncate(ason.stringify(blobData))
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

const BASE_TOOLS = [
	bash.definition,
	read.definition,
	write.definition,
	edit.definition,
	{
		name: 'grep',
		description: 'Search file contents using ripgrep. Returns matching lines with file paths and line numbers.',
		input_schema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Search pattern (regex)' },
				path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
				include: { type: 'string', description: "Glob pattern to filter files, e.g. '*.ts'" },
			},
			required: ['pattern'],
		},
	},
	{
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
	},
	{
		name: 'ls',
		description: 'List directory contents as a tree. Ignores node_modules, .git, dist, etc.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Directory to list (default: cwd)' },
				depth: { type: 'integer', description: 'Max depth (default: 3)' },
			},
		},
	},
	{
		name: 'read_blob',
		description: 'Read a stored session blob by id. Use this when history mentions `blob <id>` or an omitted image/tool result points at a blob.',
		input_schema: {
			type: 'object',
			properties: {
				blobId: { type: 'string', description: 'Stable blob id, for example from an omitted image, tool result, or thinking blob' },
			},
			required: ['blobId'],
		},
	},
	{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
	{
		name: 'ask',
		description: 'Ask the user a question and wait for their response. Use this to clarify ambiguous instructions, gather preferences, or get decisions on implementation choices.',
		input_schema: {
			type: 'object',
			properties: {
				question: { type: 'string', description: 'The question to ask the user' },
			},
			required: ['question'],
		},
	},
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
}

export function argsPreview(call: ToolCall): string {
	const inp = call.input as any
	let s: string
	switch (call.name) {
		case 'bash':
			s = bash.argsPreview(inp)
			break
		case 'read':
			s = read.argsPreview(inp)
			break
		case 'write':
			s = write.argsPreview(inp)
			break
		case 'edit':
			s = edit.argsPreview(inp)
			break
		case 'grep':
			s = String(inp?.pattern ?? '')
			break
		case 'glob':
			s = String(inp?.pattern ?? '')
			break
		case 'ls':
			s = String(inp?.path ?? '.')
			break
		case 'read_blob':
			s = String(inp?.blobId ?? '')
			break
		case 'ask':
			s = String(inp?.question ?? '').slice(0, 80)
			break
		case 'eval':
			s = String(inp?.code ?? '').slice(0, 80)
			break
		default:
			s = call.name
	}
	return shortenHome(s)
}

export async function executeTool(call: ToolCall, onChunk?: OnChunk, ctx?: ToolExecContext): Promise<string | any[]> {
	const result = await _executeTool(call, onChunk, ctx)
	return typeof result === 'string' ? shortenHome(result) : result
}

async function _executeTool(call: ToolCall, onChunk?: OnChunk, ctx?: ToolExecContext): Promise<string | any[]> {
	const err = validateRequired(call)
	if (err) return err
	const inp = call.input as any

	switch (call.name) {
		case 'bash':
			return bash.execute(inp, { cwd: CWD, signal: ctx?.signal }, onChunk)
		case 'read':
			return read.execute(inp, { cwd: CWD })
		case 'write':
			return write.execute(inp, { cwd: CWD })
		case 'edit':
			return edit.execute(inp, { cwd: CWD, contextLines: toolsConfig.contextLines })
		case 'grep': {
			const pattern = String(inp?.pattern ?? '')
			const searchPath = resolvePath(inp?.path)
			const args = ['rg', '-nH', '--no-heading', '--color=never', '--hidden', '--no-ignore', '--max-count=100', '--sort=modified']
			if (inp?.include) args.push('--glob', inp.include)
			args.push('--', pattern, searchPath)
			const result = await $`${args}`.quiet().nothrow()
			const raw = result.stdout.toString().trim()
			if (!raw) return 'No matches found.'
			return raw
		}
		case 'glob': {
			const searchPath = resolvePath(inp?.path)
			const args = ['rg', '--files', '--hidden', '--no-ignore', '--sort=modified', '--glob', String(inp?.pattern ?? ''), searchPath]
			const result = await $`${args}`.quiet().nothrow()
			const raw = result.stdout.toString().trim()
			if (!raw) return 'No files found.'
			return raw
		}
		case 'ls': {
			const dir = resolvePath(inp?.path)
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
		case 'read_blob': {
			if (!ctx?.sessionId) return 'error: read_blob requires a session context'
			const blobId = String(inp?.blobId ?? '')
			const blobData = await blob.read(ctx.sessionId, blobId)
			if (!blobData) return `error: blob not found: ${blobId}`
			return blobPreview(blobId, blobData)
		}
		case 'eval': {
			const evalCtx = ctx?.evalCtx
			if (!evalCtx) return 'error: eval tool is not enabled (set eval: true in config.ason)'
			if (!evalCtx.runtime) {
				const { runtimeCore } = await import('./runtime.ts')
				try {
					evalCtx.runtime = runtimeCore.getRuntime()
				} catch {}
			}
			return await evalTool.executeEval(String(inp.code), evalCtx)
		}
		default:
			return `Unknown tool: ${call.name}`
	}
}

export const tools = { config: toolsConfig, truncate, getTools, argsPreview, executeTool }
