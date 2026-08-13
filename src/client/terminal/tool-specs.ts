// Per-tool display specs — how each tool call renders in the history:
// header title, command/details body, and output formatting (commit
// metadata, edit diffs, count indicators, etc). Pure formatting logic;
// the actual line/background painting lives in blocks.ts.

import { resolveMarkers, toLines } from '../../utils/strings.ts'
import { ason } from '../../utils/ason.ts'
import { colors } from './colors.ts'
import { md } from './md.ts'
import { bash } from '../../server/tools/bash.ts'
// Sibling import for blocks.config; circular with blocks.ts but safe per
// module convention — all access happens at call time, never at import time.
import { blocks } from './blocks.ts'

const FG_OFF = '\x1b[39m'

function humanizeName(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ')
}

function editLineRange(input: any): string {
	if (input?.operation === 'replace') {
		const start = String(input.start_ref ?? '').trim()
		const end = String(input.end_ref ?? '').trim()
		if (!start || !end) return ''
		return start === end ? ` (${start})` : ` (${start}-${end})`
	}
	if (input?.operation !== 'insert') return ''
	const after = String(input.after_ref ?? '').trim()
	if (!after) return ''
	return after === '0:000' ? ' (before 1)' : ` (after ${after})`
}

function stripRedundantCd(command: string, cwd: string | undefined): string {
	if (!cwd) return command
	return bash.stripCdCwd(command, cwd) ?? command
}

function commitSubject(message: string): string {
	return message.split('\n').find((line) => line.trim())?.trim() ?? 'commit'
}

function formatCommitMessageBody(message: string): string | undefined {
	const lines = message.trim().split('\n')
	lines.shift()
	while (lines[0]?.trim() === '') lines.shift()
	return lines.length ? lines.join('\n') : undefined
}

const COMMIT_META_START = '[hal-commit]'
const COMMIT_META_END = '[/hal-commit]'

interface CommitFileStat {
	path: string
	added: number
	removed: number
	locDelta?: number
	locAdded?: number
	isCode: boolean
}

interface CommitMetadata {
	branch: string
	hash: string
	message?: string
	summary: string
	files: CommitFileStat[]
	locDelta?: number
	locDeltaCode?: number
	locAdded?: number
	locAddedCode?: number
}

export interface ToolFormatResult { bodyLines: string[]; hiddenIndicator?: string; suppressOutput?: boolean }
export type ToolSpec = {
	title?: (input?: any, output?: string) => string
	command?: (input?: any, output?: string) => string | undefined
	details?: (input?: any) => string | undefined
	shellContinuations?: (input?: any, output?: string) => boolean
	format?: (output: string, cols: number, input?: any) => ToolFormatResult
	// Which side of long raw output stays visible after truncation.
	// 'tail' keeps the final lines (default, useful for logs); 'head' keeps the first lines (useful for ranked search results).
	overflow?: 'head' | 'tail'
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function countIndicator(output: string, empty: string, unit: string): ToolFormatResult {
	if (!output.trim() || output === empty) return { bodyLines: [] }
	const total = toLines(output.trimEnd()).length
	return { bodyLines: [], hiddenIndicator: total > 5 ? `[${total} ${unit}]` : undefined }
}

function formatEdit(output: string): ToolFormatResult {
	if (!output) return { bodyLines: [] }
	const diffMatch = output.match(/^--- before\n([\s\S]*?)\n\n\+\+\+ after\n([\s\S]*?)(?:\n\n([\s\S]*))?$/)
	if (!diffMatch) return { bodyLines: [] }
	let beforeLines = diffMatch[1]!.split('\n').filter((line) => line.trim())
	let afterLines = diffMatch[2]!.split('\n').filter((line) => line.trim())
	const footerLines = (diffMatch[3] ?? '').split('\n').filter((line) => line.trim())
	while (beforeLines.length && afterLines.length && beforeLines[0] === afterLines[0]) {
		beforeLines.shift()
		afterLines.shift()
	}
	while (beforeLines.length && afterLines.length && beforeLines.at(-1) === afterLines.at(-1)) {
		beforeLines.pop()
		afterLines.pop()
	}
	const lines: string[] = []
	for (const [content, prefix, color] of [
		[beforeLines, '−', colors.diff.removeFg || colors.error.fg],
		[afterLines, '+', colors.diff.addFg || colors.info.fg],
	] as const) {
		if (!content.length) continue
		const max = blocks.config.maxEditDiffLines
		const limit = content.length <= max + 1 ? content.length : max
		for (const line of content.slice(0, limit)) lines.push(`${color}${prefix} ${line}${FG_OFF}`)
		if (content.length > limit) lines.push(`  … ${content.length - limit} more`)
	}
	if (footerLines.length) {
		if (lines.length) lines.push('')
		lines.push(...footerLines)
	}
	return { bodyLines: lines, suppressOutput: true }
}

function formatRead(output: string): ToolFormatResult {
	if (!output.trim()) return { bodyLines: [] }
	return { bodyLines: [`${toLines(output.trimEnd()).length} lines, ${formatSize(Buffer.byteLength(output, 'utf8'))}`] }
}

function formatEval(output: string, _cols: number): ToolFormatResult {
	if (!output) return { bodyLines: [] }
	return { bodyLines: ['Result:'], suppressOutput: false }
}

function parseCommitMetadata(output?: string): CommitMetadata | null {
	if (!output) return null
	const start = output.indexOf(COMMIT_META_START)
	if (start < 0) return null
	const dataStart = start + COMMIT_META_START.length
	const end = output.indexOf(COMMIT_META_END, dataStart)
	if (end < 0) return null
	try {
		const parsed = ason.parse(output.slice(dataStart, end).trim()) as Partial<CommitMetadata> | null
		// Guard against malformed/partial metadata: missing files array crashes downstream filters.
		if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.files)) return null
		if (typeof parsed.branch !== 'string' || typeof parsed.hash !== 'string' || typeof parsed.summary !== 'string') return null
		return parsed as CommitMetadata
	} catch {
		return null
	}
}

function signed(n: number): string {
	if (n > 0) return `+${n}`
	return String(n)
}

function commitLocDelta(file: CommitFileStat): number {
	return file.locDelta ?? file.locAdded ?? 0
}

function fileStatLine(file: CommitFileStat): string {
	const prefix = `${String(file.added).padStart(4)} −${String(file.removed).padEnd(3)}`
	const loc = file.isCode ? `  ${signed(commitLocDelta(file))} loc` : ''
	return `${prefix} ${file.path}${loc}`
}

function formatCommitOutput(output: string, _cols: number): ToolFormatResult {
	const meta = parseCommitMetadata(output)
	if (!meta) return { bodyLines: [] }
	const lines = [`${meta.branch} ${meta.hash} · ${meta.summary}`]
	// Only Hal's own commits carry LOC data. Elsewhere there is no code-vs-test
	// split to show, so list the files plainly.
	const total = meta.locDelta ?? meta.locAdded
	const codeTotal = meta.locDeltaCode ?? meta.locAddedCode
	if (total === undefined || codeTotal === undefined) {
		for (const file of meta.files) lines.push(fileStatLine(file))
		return { bodyLines: lines, suppressOutput: true }
	}
	const other = meta.files.filter((file) => !file.isCode)
	const code = meta.files.filter((file) => file.isCode)
	if (other.length) {
		lines.push('', 'Tests / docs / other')
		for (const file of other) lines.push(fileStatLine(file))
	}
	if (code.length) {
		lines.push('', 'Code')
		for (const file of code) lines.push(fileStatLine(file))
	}
	// Code LOC leads because that is the number under budget; the with-tests
	// figure trails in parentheses as context.
	lines.push('', resolveMarkers([md.mdInline(`LOC: **${signed(codeTotal)}** (with tests, ${signed(total)})`)])[0]!)
	return { bodyLines: lines, suppressOutput: true }
}

function quoteToolArg(value: unknown): string {
	const text = typeof value === 'string' ? value : '?'
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

function readBlobTitle(input: any): string {
	const id = input?.id ?? input?.blobId
	if (id == null) return 'Read blob ?'
	return `Read blob ${String(id)}`
}

function isGitCommitAmendCommand(input: any): boolean {
	const command = typeof input?.command === 'string' ? input.command : ''
	return /\bgit\s+commit\b/.test(command) && /(?:^|\s)--amend(?:\s|$)/.test(command)
}

function sendTargetLabel(input?: any, output?: string): string {
	const target = input?.sessionId ?? '?'
	const tabMatch = output?.match(/\btab (\d+) · ([^\s]+)/)
	if (tabMatch && tabMatch[2] === target) return `tab ${tabMatch[1]} · ${target}`
	return target
}

const specs: Record<string, ToolSpec> = {
	bash: {
		title(input, output) {
			const meta = parseCommitMetadata(output)
			if (meta) return `${isGitCommitAmendCommand(input) ? 'Amend' : 'Commit'} ${meta.hash}: ${commitSubject(meta.message ?? 'commit')}`
			const cmd = stripRedundantCd(input?.command ?? '', input?.cwd)
			return !cmd.includes('\n') && cmd.length <= 60 ? `Bash: ${cmd}` : 'Bash'
		},
		command(input, output) {
			const meta = parseCommitMetadata(output)
			if (meta?.message) return formatCommitMessageBody(meta.message)
			const cmd = stripRedundantCd(input?.command ?? '', input?.cwd)
			return !cmd.includes('\n') && cmd.length <= 60 ? undefined : cmd
		},
		shellContinuations(_input, output) {
			return !parseCommitMetadata(output)
		},
		format: formatCommitOutput,
	},
	read: { title(input) { const range = input?.start || input?.end ? ` (${input.start ?? 1}-${input.end ?? 'end'})` : ''; return `Read ${input?.path ?? '?'}${range}` }, format: formatRead },
	read_url: { title: (input) => `Read URL ${input?.url ?? '?'}` },
	write: {
		title: (input) => `Write ${input?.path ?? '?'}`,
		format(output) {
			const lines = output.split('\n').filter((line) => line.trim())
			return !lines.length || (lines.length === 1 && lines[0] === 'ok') ? { bodyLines: [], suppressOutput: true } : { bodyLines: lines, suppressOutput: true }
		},
	},
	read_blob: { title: readBlobTitle },
	edit: {
		title: (input) => `Edit ${input?.path ?? '?'}${editLineRange(input)}`,
		details(input) {
			if (input == null) return undefined
			const details: Record<string, string> = {}
			if (typeof input.operation === 'string') details.operation = input.operation
			if (typeof input.start_ref === 'string') details.start_ref = input.start_ref
			if (typeof input.end_ref === 'string') details.end_ref = input.end_ref
			if (typeof input.after_ref === 'string') details.after_ref = input.after_ref
			return Object.keys(details).length ? ason.stringify(details, 'long') : undefined
		},
		format: formatEdit,
	},
	eval: { title: () => 'Eval', command: (input) => input?.code ?? undefined, format: formatEval },
	grep: { title: (input) => `Grep ${quoteToolArg(input?.pattern)} in ${input?.path ?? '?'}`, format: (output) => countIndicator(output, 'No matches found.', 'matches') },
	glob: { title: (input) => `Glob ${input?.pattern ?? '?'} in ${input?.path ?? '.'}`, format: (output) => countIndicator(output, 'No files found.', 'files') },
	google: { title: (input) => `Google ${quoteToolArg(input?.query)}`, overflow: 'head' },
	web_search: { title: (input) => `web_search ${quoteToolArg(input?.query)}`, overflow: 'head' },
	ls: { title: (input) => `Ls ${input?.path ?? '.'}`, format: (output) => countIndicator(output, '(empty directory)', 'entries') },
	spawn_agent: { title: (input) => input?.title ? `Spawn agent · ${input.title}` : 'Spawn agent', details: (input) => input == null ? undefined : ason.stringify(input, 'long') },
	send: {
		title(input, output) {
			const target = sendTargetLabel(input, output)
			return input?.queue ? `Message queued for ${target}` : `Message sent to ${target}`
		},
		command(input) {
			if (typeof input?.text !== 'string') return undefined
			return input.text
		},
		format: () => ({ bodyLines: [], suppressOutput: true }),
	},
}

function getToolSpec(name: string): ToolSpec { return specs[name] ?? { title: () => humanizeName(name) } }

export const toolSpecs = {
	specs,
	getToolSpec,
	humanizeName,
}
