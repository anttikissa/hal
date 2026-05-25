// Block rendering — convert history records to visual blocks, render to
// terminal lines with colored backgrounds and headers.
//
// A single assistant history record can produce multiple blocks:
//   thinking → tool₁ → tool₂ → assistant text
// The split happens in historyToBlocks(). Rendering is in renderBlock().

import { clipVisual, expandTabs, hardWrap, M_BOLD, M_BOLD_OFF, M_ITALIC, M_ITALIC_OFF, resolveMarkers, toLines, visLen, wordWrap } from '../utils/strings.ts'
import { ason } from '../utils/ason.ts'
import { models } from '../models.ts'
import { time } from '../utils/time.ts'
import type { HistoryEntry } from '../server/sessions.ts'
import { sessionEntry } from '../session/entry.ts'
import { STATE_DIR } from '../state.ts'
import { colors } from './colors.ts'
import { md, type MdColors } from './md.ts'
import { bash } from '../tools/bash.ts'

const blockConfig = {
	tabWidth: 4,
	blobBatchSize: 64,
	maxToolOutputLines: 20,
	maxEditDiffLines: 3,
}

function sanitizeTerminalText(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (ch) => {
		if (ch === '\n' || ch === '\t') return ch
		if (ch === '\r') return '␍'
		if (ch === '\x1b') return '␛'
		return `␀${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
	})
}

function stripAnsiSequences(text: string): string {
	let out = ''
	for (let i = 0; i < text.length; ) {
		const ch = text[i]!
		if (ch !== '\x1b') {
			out += ch
			i++
			continue
		}
		const next = text[i + 1]
		if (!next) break
		if (next === '[') {
			i += 2
			while (i < text.length) {
				const code = text.charCodeAt(i++)
				if (code >= 0x40 && code <= 0x7e) break
			}
			continue
		}
		if (next === ']') {
			i += 2
			while (i < text.length) {
				if (text[i] === '\x07') {
					i++
					break
				}
				if (text[i] === '\x1b' && text[i + 1] === '\\') {
					i += 2
					break
				}
				i++
			}
			continue
		}
		i += 2
	}
	return out
}

interface BlockBase { ts?: number; dimmed?: boolean; renderVersion?: number }
interface TextBlock extends BlockBase { text: string }
interface BlobRef { blobId?: string; sessionId?: string; blobLoaded?: boolean }
type NoticeBlock<T extends 'log' | 'info' | 'warning' | 'fork'> = { type: T } & TextBlock

export type Block =
	| ({ type: 'user'; source?: string; status?: string } & TextBlock)
	| ({ type: 'assistant'; model?: string; id?: string; continue?: string; streaming?: boolean; synthetic?: boolean; syntheticKind?: string } & TextBlock)
	| ({ type: 'thinking'; model?: string; thinkingEffort?: string; streaming?: boolean } & TextBlock & BlobRef)
	| ({ type: 'tool'; name: string; input?: any; output?: string; toolId?: string } & BlockBase & BlobRef)
	| NoticeBlock<'log'>
	| NoticeBlock<'info'>
	| NoticeBlock<'warning'>
	| NoticeBlock<'fork'>
	| ({ type: 'error' } & TextBlock & Pick<BlobRef, 'blobId' | 'sessionId'>)

function touch(block: Block): void {
	block.renderVersion = (block.renderVersion ?? 0) + 1
}

function markdownSourceText(block: Exclude<Block, { type: 'tool' | 'user' | 'fork' }>): string {
	const text =
		block.type === 'log' || block.type === 'info' || block.type === 'warning' || block.type === 'error'
			? stripAnsiSequences(block.text)
			: block.text
	return sanitizeTerminalText(text)
}

function parseTs(ts?: string): number | undefined {
	return ts ? Date.parse(ts) : undefined
}

function blobPath(sessionId: string, blobId: string): string {
	return `${STATE_DIR}/sessions/${sessionId}/blobs/${blobId}.ason`
}

function historyToBlocks(
	history: HistoryEntry[],
	sessionId: string,
	parentEntryCount = 0,
	parentId?: string,
	initialModel?: string,
): Block[] {
	const result: Block[] = []
	for (let i = 0; i < history.length; i++) {
		const entry = history[i]!
		const ts = parseTs(entry.ts)
		const dimmed = i < parentEntryCount ? true : undefined
		const blobOwner = i < parentEntryCount && parentId ? parentId : sessionId
		switch (entry.type) {
			case 'user': {
				const text = sessionEntry.userText(entry, { images: 'path-or-image', display: 'ui' })
				if (!text) break
				const isSystem = text.startsWith('[system] ')
				result.push({
					type: 'user',
					text: isSystem ? text.slice(9) : text,
					source: isSystem ? 'system' : entry.source ?? undefined,
					status: entry.status,
					ts,
					dimmed,
				})
				break
			}
			case 'thinking': {
				const model = entry.model ?? initialModel
				result.push({
					type: 'thinking',
					text: entry.text ?? '',
					model,
					thinkingEffort: entry.thinkingEffort ?? models.reasoningEffort(model),
					blobId: entry.blobId,
					sessionId: blobOwner,
					ts,
					dimmed,
				})
				break
			}
			case 'tool_call':
				result.push({ type: 'tool', name: entry.name, input: entry.input, blobId: entry.blobId, sessionId: blobOwner, toolId: entry.toolId, ts, dimmed })
				break
			case 'assistant':
				result.push({
					type: 'assistant',
					text: entry.text,
					model: entry.model ?? initialModel,
					continue: entry.continue,
					synthetic: entry.synthetic,
					syntheticKind: entry.syntheticKind,
					ts,
					dimmed,
				})
				break
			case 'log':
				result.push({ type: entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'log', text: entry.text, ts, dimmed })
				break
			case 'info':
			case 'warning':
			case 'error':
				result.push({ type: entry.type, text: entry.text, ts, dimmed })
				break
			case 'forked_from':
				result.push({ type: 'info', text: `Tab forked from ${entry.parent}.`, ts, dimmed })
				break
			case 'forked_to':
				result.push({ type: 'info', text: `Tab forked to ${entry.child}.`, ts, dimmed })
				break
			case 'rebased_from':
				result.push({ type: 'info', text: `Rebased from ${entry.log}.`, ts, dimmed })
				break
			case 'rebased_to':
				result.push({ type: 'info', text: `Rebased to ${entry.log}.`, ts, dimmed })
				break
			case 'cwd':
				result.push({ type: 'info', text: `cwd: ${entry.from} -> ${entry.to}`, ts, dimmed })
				break
			case 'model':
				result.push({ type: 'info', text: `model: ${entry.from} -> ${entry.to}`, ts, dimmed })
				break
		}
	}
	return result
}

function parseBlob(text: string): any | null {
	try {
		return ason.parse(text)
	} catch {
		return null
	}
}

function applyToolBlob(block: Extract<Block, { type: 'tool' }>, text: string): void {
	block.blobLoaded = true
	const blob = parseBlob(text)
	if (!blob) return
	block.input = blob?.call?.input
	if (typeof blob?.result?.content === 'string') block.output = blob.result.content
	touch(block)
}

function applyThinkingBlob(block: Extract<Block, { type: 'thinking' }>, text: string): void {
	block.blobLoaded = true
	const blob = parseBlob(text)
	if (!blob || typeof blob?.thinking !== 'string') return
	block.text = blob.thinking
	touch(block)
}

const MAX_BLOB_SIZE = 1024 * 1024

type BlobBlock = Extract<Block, { type: 'tool' | 'thinking' }>

async function loadBlobs(blocks: Block[]): Promise<number> {
	const pending = blocks.filter(
		(block): block is BlobBlock =>
			(block.type === 'tool' || block.type === 'thinking') && !block.blobLoaded && !!block.blobId,
	)
	if (pending.length === 0) return 0
	for (let i = 0; i < pending.length; i += blockConfig.blobBatchSize) {
		const batch = pending.slice(i, i + blockConfig.blobBatchSize)
		const files = batch.map((block) => Bun.file(blobPath(block.sessionId ?? '', block.blobId!)))
		const sizes = await Promise.allSettled(files.map((file) => file.size))
		const reads = files.map((file, index) => {
			const size = sizes[index]!
			return size.status === 'fulfilled' && size.value <= MAX_BLOB_SIZE ? file.text() : Promise.resolve(null)
		})
		const results = await Promise.allSettled(reads)
		for (let j = 0; j < batch.length; j++) {
			const result = results[j]!
			const block = batch[j]!
			if (result.status === 'fulfilled' && result.value !== null) {
				if (block.type === 'tool') applyToolBlob(block, result.value)
				else applyThinkingBlob(block, result.value)
			} else {
				block.blobLoaded = true
			}
		}
		await Bun.sleep(0)
	}
	return pending.length
}

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

const [RED_FG, GREEN_FG, FG_OFF, RESET_BG, DIM, DIM_OFF] = ['\x1b[31m', '\x1b[32m', '\x1b[39m', '\x1b[49m', '\x1b[2m', '\x1b[22m']

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

interface ToolFormatResult { bodyLines: string[]; hiddenIndicator?: string; suppressOutput?: boolean }
type ToolSpec = {
	title?: (input?: any, output?: string) => string
	command?: (input?: any, output?: string) => string | undefined
	details?: (input?: any) => string | undefined
	shellContinuations?: (input?: any, output?: string) => boolean
	format?: (output: string, cols: number, input?: any) => ToolFormatResult
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
		[beforeLines, '−', RED_FG],
		[afterLines, '+', GREEN_FG],
	] as const) {
		if (!content.length) continue
		const limit = content.length <= blockConfig.maxEditDiffLines + 1 ? content.length : blockConfig.maxEditDiffLines
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

function formatEval(output: string, cols: number): ToolFormatResult {
	if (!output) return { bodyLines: [] }
	const label = '── Result '
	const width = Math.max(0, cols - visLen(label))
	return { bodyLines: [`${label}${'─'.repeat(width)}`], suppressOutput: false }
}

function parseCommitMetadata(output: string): CommitMetadata | null {
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

function commitMetadataFromOutput(output?: string): CommitMetadata | null {
	return output ? parseCommitMetadata(output) : null
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
	const hasNetLoc = meta.locDelta !== undefined || meta.locDeltaCode !== undefined
	const total = meta.locDelta ?? meta.locAdded ?? 0
	const codeTotal = meta.locDeltaCode ?? meta.locAddedCode ?? 0
	const locLabel = hasNetLoc ? 'Net LOC' : 'Added LOC'
	lines.push('', resolveMarkers([md.mdInline(`${locLabel}: ${signed(total)} total, **${signed(codeTotal)} excluding tests**`)])[0]!)
	return { bodyLines: lines, suppressOutput: true }
}

function quoteToolArg(value: unknown): string {
	const text = typeof value === 'string' ? value : '?'
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

const toolSpecs: Record<string, ToolSpec> = {
	bash: {
		title(input, output) {
			const meta = commitMetadataFromOutput(output)
			if (meta) return `Commit ${meta.hash}: ${commitSubject(meta.message ?? 'commit')}`
			const cmd = stripRedundantCd(input?.command ?? '', input?.cwd)
			return !cmd.includes('\n') && cmd.length <= 60 ? `Bash: ${cmd}` : 'Bash'
		},
		command(input, output) {
			const meta = commitMetadataFromOutput(output)
			if (meta?.message) return formatCommitMessageBody(meta.message)
			const cmd = stripRedundantCd(input?.command ?? '', input?.cwd)
			return !cmd.includes('\n') && cmd.length <= 60 ? undefined : cmd
		},
		shellContinuations(_input, output) {
			return !commitMetadataFromOutput(output)
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
	google: { title: (input) => `Google ${input?.query ?? '?'}` },
	analyze_history: { title: (input) => `Analyze history${input?.sessionId ? ` ${input.sessionId}` : ''}` },
	ls: { title: (input) => `Ls ${input?.path ?? '.'}`, format: (output) => countIndicator(output, '(empty directory)', 'entries') },
	spawn_agent: { title: (input) => input?.title ? `Spawn agent · ${input.title}` : 'Spawn agent', details: (input) => input == null ? undefined : ason.stringify(input, 'long') },
}

function getToolSpec(name: string): ToolSpec { return toolSpecs[name] ?? { title: () => humanizeName(name) } }

function pushDimWrapped(lines: string[], text: string, cols: number): void {
	for (const raw of text.split('\n')) for (const line of hardWrap(expandTabs(raw, blockConfig.tabWidth), cols)) lines.push(`${DIM}${line}${DIM_OFF}`)
}

function markdownColors(block: Extract<Block, { type: 'assistant' | 'thinking' | 'log' | 'info' | 'warning' | 'error' }>): MdColors {
	const palette = blockColors(block)
	return {
		bold: [M_BOLD, M_BOLD_OFF],
		italic: [M_ITALIC, M_ITALIC_OFF],
		code: palette.code ? [palette.code, palette.fg] : [palette.fg, palette.fg],
	}
}

function pushCodeWrapped(lines: string[], text: string, cols: number, mdColors: MdColors): void {
	for (const raw of text.split('\n')) {
		for (const line of hardWrap(expandTabs(raw, blockConfig.tabWidth), cols)) {
			lines.push(`${mdColors.code[0]}${line}${mdColors.code[1]}`)
		}
	}
}

function renderMarkdownLines(block: Extract<Block, { type: 'assistant' | 'thinking' | 'log' | 'info' | 'warning' | 'error' }>, cols: number): string[] {
	const lines: string[] = []
	const mdColors = markdownColors(block)
	for (const span of md.mdSpans(markdownSourceText(block))) {
		if (span.type === 'code') {
			for (const raw of span.lines) pushCodeWrapped(lines, raw, cols, mdColors)
		} else if (span.type === 'table') {
			lines.push(...md.mdTable(span.lines, cols, mdColors))
		} else {
			for (const line of span.lines) lines.push(...wordWrap(md.mdInline(line, mdColors), cols))
		}
	}
	while (lines[0]?.trim() === '') lines.shift()
	while (lines.at(-1)?.trim() === '') lines.pop()
	return resolveMarkers(lines)
}

function formatToolCommand(cmd: string, cols: number, shellContinuations: boolean): string[] {
	const rawLines = cmd.split('\n')
	if (rawLines.length === 1 && visLen(cmd) <= cols) return [cmd]
	const result: string[] = []
	for (let i = 0; i < rawLines.length; i++) {
		const isLastRaw = i === rawLines.length - 1
		const wrapWidth = shellContinuations ? Math.max(1, cols - 2) : cols
		const wrapped = wordWrap(rawLines[i]!, wrapWidth)
		for (let j = 0; j < wrapped.length; j++) {
			const isLastWrapped = isLastRaw && j === wrapped.length - 1
			result.push(shellContinuations && !isLastWrapped ? `${wrapped[j]!} \\` : wrapped[j]!)
		}
	}
	return result
}

function clipLine(line: string, cols: number): string {
	return visLen(expandTabs(line, blockConfig.tabWidth)) <= cols
		? line
		: clipVisual(expandTabs(line, blockConfig.tabWidth), cols)
}

function blockContent(block: Block, cols: number): string[] {
	if (
		block.type === 'assistant' ||
		block.type === 'thinking' ||
		block.type === 'log' ||
		block.type === 'info' ||
		block.type === 'warning' ||
		block.type === 'error'
	) {
		return renderMarkdownLines(block, cols)
	}
	if (block.type === 'tool') {
		const lines: string[] = []
		const spec = getToolSpec(block.name)
		const command = spec.command?.(block.input, block.output)
		if (command) lines.push(...formatToolCommand(command, cols, spec.shellContinuations?.(block.input, block.output) ?? block.name === 'bash'))
		const details = spec.details?.(block.input)
		if (details) pushDimWrapped(lines, details, cols)
		if (!block.output) return lines
		const output = sanitizeTerminalText(stripAnsiSequences(block.output))
		const format = spec.format?.(output, cols, block.input) ?? { bodyLines: [] }
		for (const line of format.bodyLines) lines.push(clipLine(line, cols))
		if (format.suppressOutput) return lines
		const outputLines = output.trimEnd().split('\n')
		if (outputLines.length > blockConfig.maxToolOutputLines) {
			const hidden = format.hiddenIndicator ?? `[+ ${outputLines.length - blockConfig.maxToolOutputLines} lines]`
			lines.push(`${DIM}${hidden}${DIM_OFF}`)
			for (const line of outputLines.slice(-blockConfig.maxToolOutputLines)) lines.push(clipLine(line, cols))
			return lines
		}
		for (const line of outputLines) lines.push(clipLine(line, cols))
		return lines
	}
	const lines: string[] = []
	for (const raw of expandTabs(sanitizeTerminalText(block.text), blockConfig.tabWidth).split('\n')) {
		lines.push(...wordWrap(raw, cols))
	}
	return lines
}

function bgLine(content: string, cols: number, bg: string): string {
	if (!content.includes('\t'))
		return visLen(content) >= cols ? `${bg}${content}${RESET_BG}` : `${bg}${content}\x1b[K${RESET_BG}`
	return `${bg}\x1b[K\r${content}${RESET_BG}`
}

const fixedNoticeColors = { log: colors.log, info: colors.info, warning: colors.warning, error: colors.error, fork: colors.fork }

function blockColors(block: Block): { fg: string; bg: string; bold?: string; code?: string } {
	if (block.type === 'assistant') return colors.assistant
	if (block.type === 'thinking') return colors.thinking
	if (block.type === 'user') return colors.user
	return block.type === 'tool' ? colors.tool(block.name) : fixedNoticeColors[block.type]
}

function formatBlockTime(ts?: number): string {
	return time.formatTimestamp(ts)
}

function formatBlockTimeRange(first?: number, last?: number): string {
	return time.formatTimestampRange(first, last)
}

function buildHeader(title: string, time: string, blobRef: string, cols: number): string {
	const right = blobRef ? ` ${DIM}(${blobRef})${DIM_OFF} ──` : ''
	const prefix = time ? `── ${time} ` : '── '
	const budget = Math.max(1, cols - 1)
	const titleWidth = Math.max(1, budget - visLen(prefix) - visLen(right) - 1)
	const left = `${prefix}${clipVisual(title, titleWidth)} `
	return `${left}${'─'.repeat(Math.max(0, budget - visLen(left) - visLen(right)))}${right}`
}

const fixedLabels = { log: 'Log', info: 'Info', warning: 'Warning', error: 'Error', fork: 'Info' }

function blockLabel(block: Block): string {
	if (block.type === 'user') {
		if (block.source && block.source !== 'user' && block.source !== 'system') return `Inbox · ${block.source}`
		if (block.status === 'steering') return 'You (steering)'
		if (block.status === 'queued') return 'You (queued)'
		return 'You'
	}
	if (block.type === 'assistant') {
		const display = models.displayModel(block.model)
		if (display && block.synthetic) return `Hal (${display}, synthetic)`
		if (display) return `Hal (${display})`
		return block.synthetic ? 'Hal (synthetic)' : 'Hal'
	}
	if (block.type === 'thinking') {
		const display = models.displayModel(block.model)
		const effort = block.thinkingEffort ?? models.reasoningEffort(block.model)
		if (display && effort) return `Hal (${display}, thinking ${effort})`
		if (display) return `Hal (${display}, thinking)`
		return 'Thinking'
	}
	if (block.type === 'tool') return getToolSpec(block.name).title?.(block.input, block.output) ?? humanizeName(block.name)
	return fixedLabels[block.type]
}

function renderBlockGroup(group: Array<Extract<Block, { type: 'log' | 'info' | 'warning' | 'error' }>>, cols: number): string[] {
	if (group.length === 0) return []
	if (group.length === 1) return renderBlock(group[0]!, cols)
	const first = group[0]!
	const last = group[group.length - 1]!
	const label = fixedLabels[first.type]
	const header = buildHeader(label, formatBlockTimeRange(first.ts, last.ts), '', cols)
	const { fg, bg } = blockColors(first)
	const lines = [bgLine(`${fg}${header}`, cols, bg)]
	for (const block of group) {
		for (const line of renderMarkdownLines(block, cols)) lines.push(bgLine(`${fg}${line}`, cols, bg))
	}
	lines[lines.length - 1]! += FG_OFF
	return lines
}

function hasStreamingHalCursor(block: Block): boolean {
	return (block.type === 'assistant' || block.type === 'thinking') && !!block.streaming
}

function cursorColor(block?: Block): string {
	if (block?.type === 'thinking') return colors.thinking.fg
	return colors.input.cursor || colors.assistant.fg
}

function cursorGlyph(block: Block, visible: boolean): string {
	return visible ? `${cursorColor(block)}█${FG_OFF}` : ' '
}

function withInlineCursor(line: string, block: Block, cols: number, visible: boolean): string[] {
	const glyph = cursorGlyph(block, visible)
	const eraseIndex = line.lastIndexOf('\x1b[K')
	if (eraseIndex >= 0) {
		const beforeErase = line.slice(0, eraseIndex)
		const afterErase = line.slice(eraseIndex)
		if (visLen(beforeErase) < cols) return [beforeErase + glyph + afterErase]
	}

	// If the rendered row is already full-width, adding another printable cell
	// would trigger terminal auto-wrap and break the one-array-line = one-row
	// invariant. Put the HAL cursor on its own row instead.
	if (visLen(line) >= cols) return [line, glyph]
	return [line + glyph]
}

function addInlineCursor(lines: string[], block: Block, cols: number, visible: boolean): void {
	const last = lines.at(-1)
	if (last == null) return
	lines.splice(lines.length - 1, 1, ...withInlineCursor(last, block, cols, visible))
}

function renderBlock(block: Block, cols: number, cursorVisible = false): string[] {
	const blobRef =
		'blobId' in block && 'sessionId' in block && block.blobId && block.sessionId
			? `${block.sessionId}/${block.blobId}`
			: ''
	const { fg, bg } = blockColors(block)
	const lines = [bgLine(`${fg}${buildHeader(blockLabel(block), formatBlockTime(block.ts), blobRef, cols)}`, cols, bg)]
	for (const line of blockContent(block, cols)) lines.push(bgLine(`${fg}${line}`, cols, bg))
	lines[lines.length - 1]! += FG_OFF
	// Streaming cursors are progress markers, not idle blinkers: keep them solid
	// so the active streamed block is always visually anchored.
	if (hasStreamingHalCursor(block)) addInlineCursor(lines, block, cols, true)
	return lines
}

export const blocks = {
	config: blockConfig,
	historyToBlocks,
	touch,
	renderBlock,
	cursorColor,
	renderBlockGroup,
	loadBlobs,
}
