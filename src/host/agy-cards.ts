// Formats `agy acp` tool calls and results as readable Hal tool cards
// (common/tool-presentation.ts) for both terminal and web: clean shell
// commands, numbered diffs, file reads, searches, and Hal's own MCP tools.
// Task xbp.

import { relative } from 'path'
import type { HostedToolBlock } from '../common/blocks.ts'
import { home } from '../common/home.ts'
import { toolDetails } from '../common/tool-details.ts'
import { toolPresentation, type PresentationBlock, type ToolPresentation } from '../common/tool-presentation.ts'
import type { McpResult } from './agy-mcp.ts'
import { textDiff } from './text-diff.ts'
import { toolPresentations } from './tool-presentation.ts'

type AcpTool = Record<string, any>

const MCP_PREFIX = 'mcp_ide-tools_'

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, ' ').trim()
}

function shortPath(path: string, cwd: string): string {
	let rel = relative(cwd, path)
	if (rel && !rel.startsWith('..') && !rel.startsWith('/')) return rel
	return home.short(path)
}

function stripAgyMeta(text: string): string {
	let out = text
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/^(?:Created At|Completed At): [^\n]*\n/gm, '')
	let exited = /^Command exited with code (\d+)\.\n*/.exec(out)
	if (exited) {
		let rest = out.slice(exited[0].length).replace(/^Command output:\n/, '')
		out = exited[1] === '0' ? rest : `Exit code ${exited[1]}\n${rest}`
	}
	return out.trimEnd()
}

function rawText(tool: AcpTool): string {
	let parts: string[] = []
	for (let c of tool.content ?? []) {
		if (c.type === 'content' && c.content?.type === 'text' && typeof c.content.text === 'string')
			parts.push(c.content.text)
	}
	if (!parts.length && typeof tool.rawOutput?.output === 'string') parts.push(tool.rawOutput.output)
	else if (!parts.length && tool.rawOutput && Object.keys(tool.rawOutput).length)
		parts.push(JSON.stringify(tool.rawOutput))
	return parts.join('\n')
}

function checked(p: ToolPresentation | undefined, output: string): ToolPresentation | undefined {
	if (!p) return undefined
	try {
		toolPresentation.check(p, output)
		return p
	} catch {
		return undefined
	}
}

function formatDiffs(
	tool: AcpTool,
	cwd: string,
): { files: string[]; blocks: PresentationBlock[]; output: string } | undefined {
	let diffs = (tool.content ?? []).filter((c: any) => c?.type === 'diff' && typeof c.path === 'string')
	if (!diffs.length) return undefined
	let files: string[] = []
	let blocks: PresentationBlock[] = []
	let parts: string[] = []
	for (let d of diffs) {
		let rel = shortPath(d.path, cwd)
		let oldText = typeof d.oldText === 'string' ? d.oldText : ''
		let newText = typeof d.newText === 'string' ? d.newText : ''
		files.push(oldText ? rel : `${rel}+`)
		let body = ''
		try {
			body = textDiff.text(oldText, newText, Infinity, true)
		} catch {}
		if (!body)
			body = newText
				? newText
						.split('\n')
						.map((l: string, i: number) => `+${i + 1} ${l}`)
						.join('\n')
				: '(no changes)'
		blocks.push({ kind: 'diff', path: rel, text: body })
		parts.push(diffs.length > 1 ? `${rel}\n${body}` : body)
	}
	return { files, blocks, output: parts.join('\n\n') }
}

function hosted(tool: AcpTool, cwd: string, mcpResult?: McpResult): HostedToolBlock {
	let id = String(tool.toolCallId ?? crypto.randomUUID())
	let rawName = String(tool.name ?? tool.kind ?? 'tool')
	let rawInput: Record<string, unknown> =
		tool.rawInput && typeof tool.rawInput === 'object'
			? { ...tool.rawInput }
			: tool.args && typeof tool.args === 'object'
				? { ...tool.args }
				: {}
	let isError = tool.status === 'failed' || mcpResult?.isError === true

	// Hal's own tools exposed via --ide-mcp-port keep their native Hal cards.
	if (rawName.startsWith(MCP_PREFIX)) {
		let name = rawName.slice(MCP_PREFIX.length)
		delete rawInput.toolSummary
		let output = mcpResult ? mcpResult.output : stripAgyMeta(rawText(tool))
		let presentation = checked(
			toolPresentations.present(
				{ type: 'tool_call', id, name, input: rawInput },
				{ type: 'tool_result', id, output, ...(isError && { isError: true }) },
			),
			output,
		)
		return {
			type: 'hosted_tool',
			id,
			name,
			input: rawInput,
			output,
			...(isError && { isError: true }),
			...(presentation && { presentation }),
		}
	}

	let summary = str(rawInput.toolSummary)
	let kind = str(tool.kind)

	// Diff / edit tools.
	let diffs = formatDiffs(tool, cwd)
	if (diffs) {
		let title = `edit ${diffs.files.join(', ')}${summary ? `: ${oneLine(summary)}` : ''}`
		let presentation = checked({ title, blocks: diffs.blocks, readOnly: false }, diffs.output)
		return {
			type: 'hosted_tool',
			id,
			name: rawName,
			input: rawInput,
			output: diffs.output,
			...(isError && { isError: true }),
			...(presentation && { presentation }),
		}
	}

	// Shell commands.
	if (rawName === 'run_command' || kind === 'execute') {
		let command = str(rawInput.CommandLine ?? rawInput.command)
		let output = stripAgyMeta(rawText(tool))
		let label = summary ?? (command ? oneLine(command.split('\n')[0]!) : (str(tool.title) ?? 'command'))
		let blocks: PresentationBlock[] = []
		if (command) blocks.push({ kind: 'code', language: 'sh', text: command })
		if (output && !isError) blocks.push({ kind: 'text', text: { from: 0, to: output.length } })
		let presentation = checked({ title: `bash ${oneLine(label)}`, blocks, readOnly: false }, output)
		return {
			type: 'hosted_tool',
			id,
			name: rawName,
			input: rawInput,
			output,
			...(isError && { isError: true }),
			...(presentation && { presentation }),
		}
	}

	// File reads.
	if (rawName === 'read_file' || rawName === 'view_file' || kind === 'read') {
		let file = str(rawInput.Path ?? rawInput.AbsolutePath ?? tool.locations?.[0]?.path)
		let start = typeof rawInput.StartLine === 'number' ? rawInput.StartLine : undefined
		let end = typeof rawInput.EndLine === 'number' ? rawInput.EndLine : undefined
		let range = start !== undefined ? `:${start}${end !== undefined ? `-${end}` : ''}` : ''
		let target = file ? `${shortPath(file, cwd)}${range}` : (str(tool.title) ?? rawName)
		let output = stripAgyMeta(rawText(tool))
		let blocks: PresentationBlock[] = output && !isError ? [{ kind: 'text', text: { from: 0, to: output.length } }] : []
		let presentation = checked({ title: `read ${oneLine(target)}`, blocks, readOnly: true }, output)
		return {
			type: 'hosted_tool',
			id,
			name: rawName,
			input: rawInput,
			output,
			...(isError && { isError: true }),
			...(presentation && { presentation }),
		}
	}

	// Searches and directory listings.
	let readOnly =
		kind === 'search' ||
		kind === 'think' ||
		rawName === 'grep_search' ||
		rawName === 'find_by_name' ||
		rawName === 'list_dir' ||
		rawName === 'search_web'
	let output = stripAgyMeta(rawText(tool))
	let verb =
		rawName === 'grep_search'
			? 'grep'
			: rawName === 'find_by_name'
				? 'find'
				: rawName === 'list_dir'
					? 'list'
					: rawName === 'search_web'
						? 'search'
						: rawName
	let headArg =
		summary ??
		str(rawInput.Query ?? rawInput.query ?? rawInput.Pattern ?? rawInput.DirectoryPath ?? rawInput.SearchPath) ??
		str(tool.title)
	let title = headArg ? `${verb} ${oneLine(headArg)}` : verb
	let restInput = Object.fromEntries(Object.entries(rawInput).filter(([k]) => k !== 'toolSummary'))
	let blocks: PresentationBlock[] = []
	if (Object.keys(restInput).length && !readOnly)
		blocks.push({ kind: 'text', text: toolDetails.value(restInput).join('\n') })
	if (output && !isError) blocks.push({ kind: 'text', text: { from: 0, to: output.length } })
	let presentation = checked({ title, blocks, readOnly }, output)
	return {
		type: 'hosted_tool',
		id,
		name: rawName,
		input: rawInput,
		output,
		...(isError && { isError: true }),
		...(presentation && { presentation }),
	}
}

export const agyCards = { hosted, stripAgyMeta }
