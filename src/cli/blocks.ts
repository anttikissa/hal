// Block rendering — convert history records to visual blocks, render to
// terminal lines with colored backgrounds and headers.
//
// A single assistant history record can produce multiple blocks:
//   thinking → tool₁ → tool₂ → assistant text
// The split happens in historyToBlocks(). Rendering is in renderBlock().

import { clipVisual, expandTabs, hardWrap, resolveMarkers, toLines, visLen, wordWrap } from '../utils/strings.ts'
import { ason } from '../utils/ason.ts'
import { models } from '../models.ts'
import type { HistoryEntry } from '../server/sessions.ts'
import { sessionEntry } from '../session/entry.ts'
import { STATE_DIR } from '../state.ts'
import { colors } from './colors.ts'
import { md } from './md.ts'

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
type NoticeBlock<T extends 'info' | 'warning' | 'startup' | 'fork'> = { type: T } & TextBlock

export type Block =
	| ({ type: 'user'; source?: string; status?: string } & TextBlock)
	| ({ type: 'assistant'; model?: string; id?: string; continue?: string; streaming?: boolean } & TextBlock)
	| ({ type: 'thinking'; model?: string; thinkingEffort?: string; streaming?: boolean } & TextBlock & BlobRef)
	| ({ type: 'tool'; name: string; input?: any; output?: string; toolId?: string } & BlockBase & BlobRef)
	| NoticeBlock<'info'>
	| NoticeBlock<'warning'>
	| NoticeBlock<'startup'>
	| NoticeBlock<'fork'>
	| ({ type: 'error' } & TextBlock & Pick<BlobRef, 'blobId' | 'sessionId'>)

function touch(block: Block): void {
	block.renderVersion = (block.renderVersion ?? 0) + 1
}

function markdownSourceText(block: Exclude<Block, { type: 'tool' | 'user' | 'startup' | 'fork' }>): string {
	const text =
		block.type === 'info' || block.type === 'warning' || block.type === 'error'
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
				result.push({ type: 'assistant', text: entry.text, model: entry.model ?? initialModel, id: entry.id, continue: entry.continue, ts, dimmed })
				break
			case 'info':
				result.push({ type: entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info', text: entry.text, ts, dimmed })
				break
			case 'forked_from':
				result.push({ type: 'fork', text: `Forked from ${entry.parent}`, ts, dimmed })
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

interface ToolFormatResult { bodyLines: string[]; hiddenIndicator?: string; suppressOutput?: boolean }
type ToolSpec = {
	title?: (input?: any) => string
	command?: (input?: any) => string | undefined
	details?: (input?: any) => string | undefined
	format?: (output: string) => ToolFormatResult
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

const toolSpecs: Record<string, ToolSpec> = {
	bash: {
		title(input) {
			const cmd = input?.command ?? ''
			return !cmd.includes('\n') && cmd.length <= 60 ? `Bash: ${cmd}` : 'Bash'
		},
		command(input) {
			const cmd = input?.command ?? ''
			return !cmd.includes('\n') && cmd.length <= 60 ? undefined : cmd
		},
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
	eval: { title: () => 'Eval', command: (input) => input?.code ?? undefined },
	grep: { title: (input) => `Grep ${input?.pattern ?? '?'} in ${input?.path ?? '?'}`, format: (output) => countIndicator(output, 'No matches found.', 'matches') },
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

function renderMarkdownLines(block: Extract<Block, { type: 'assistant' | 'thinking' | 'info' | 'warning' | 'error' }>, cols: number): string[] {
	const lines: string[] = []
	for (const span of md.mdSpans(markdownSourceText(block))) {
		if (span.type === 'code') {
			for (const raw of span.lines) pushDimWrapped(lines, raw, cols)
		} else if (span.type === 'table') {
			lines.push(...md.mdTable(span.lines, cols))
		} else {
			for (const line of span.lines) lines.push(...wordWrap(md.mdInline(line), cols))
		}
	}
	while (lines[0]?.trim() === '') lines.shift()
	while (lines.at(-1)?.trim() === '') lines.pop()
	return resolveMarkers(lines)
}

function formatBashCommand(cmd: string, cols: number): string[] {
	const rawLines = cmd.split('\n')
	if (rawLines.length === 1 && visLen(cmd) <= cols) return [cmd]
	const result: string[] = []
	for (let i = 0; i < rawLines.length; i++) {
		const isLastRaw = i === rawLines.length - 1
		const wrapWidth = isLastRaw ? cols : cols - 2
		const wrapped = wordWrap(rawLines[i]!, wrapWidth)
		for (let j = 0; j < wrapped.length; j++)
			result.push(isLastRaw && j === wrapped.length - 1 ? wrapped[j]! : `${wrapped[j]!} \\`)
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
		block.type === 'info' ||
		block.type === 'warning' ||
		block.type === 'error'
	) {
		return renderMarkdownLines(block, cols)
	}
	if (block.type === 'tool') {
		const lines: string[] = []
		const spec = getToolSpec(block.name)
		const command = spec.command?.(block.input)
		if (command) lines.push(...formatBashCommand(command, cols))
		const details = spec.details?.(block.input)
		if (details) pushDimWrapped(lines, details, cols)
		if (!block.output) return lines
		const output = sanitizeTerminalText(stripAnsiSequences(block.output))
		const format = spec.format?.(output) ?? { bodyLines: [] }
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

const fixedNoticeColors = { info: colors.info, warning: colors.warning, error: colors.error, startup: colors.startup, fork: colors.fork }

function blockColors(block: Block): { fg: string; bg: string } {
	if (block.type === 'assistant') return colors.assistant
	if (block.type === 'thinking') return colors.thinking
	if (block.type === 'user') return colors.user
	return block.type === 'tool' ? colors.tool(block.name) : fixedNoticeColors[block.type]
}

function formatHHMM(ts?: number): string {
	if (!ts) return ''
	const date = new Date(ts)
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function buildHeader(title: string, time: string, blobRef: string, cols: number): string {
	const right = blobRef ? ` ${DIM}(${blobRef})${DIM_OFF} ──` : ''
	const prefix = time ? `── ${time} ` : '── '
	const budget = Math.max(1, cols - 1)
	const titleWidth = Math.max(1, budget - visLen(prefix) - visLen(right) - 1)
	const left = `${prefix}${clipVisual(title, titleWidth)} `
	return `${left}${'─'.repeat(Math.max(0, budget - visLen(left) - visLen(right)))}${right}`
}

const fixedLabels = { info: 'Info', warning: 'Warning', error: 'Error', startup: 'Startup', fork: 'Fork' }

function blockLabel(block: Block): string {
	if (block.type === 'user') {
		if (block.source && block.source !== 'user' && block.source !== 'system') return `Inbox · ${block.source}`
		if (block.status === 'steering') return 'You (steering)'
		if (block.status === 'queued') return 'You (queued)'
		return 'You'
	}
	if (block.type === 'assistant') {
		const display = models.displayModel(block.model)
		return display ? `Hal (${display})` : 'Hal'
	}
	if (block.type === 'thinking') {
		const display = models.displayModel(block.model)
		const effort = block.thinkingEffort ?? models.reasoningEffort(block.model)
		if (display && effort) return `Hal (${display}, thinking ${effort})`
		if (display) return `Hal (${display}, thinking)`
		return 'Thinking'
	}
	if (block.type === 'tool') return getToolSpec(block.name).title?.(block.input) ?? humanizeName(block.name)
	return fixedLabels[block.type]
}

function renderBlockGroup(group: Array<Extract<Block, { type: 'info' | 'warning' | 'error' }>>, cols: number): string[] {
	if (group.length === 0) return []
	if (group.length === 1) return renderBlock(group[0]!, cols)
	const header = buildHeader('Info', formatHHMM(group[0]!.ts), '', cols)
	const text = group.map((block) => `[${expandTabs(block.text, blockConfig.tabWidth)}]`).join(' ')
	const { fg, bg } = colors.info
	const lines = [bgLine(`${fg}${header}`, cols, bg)]
	for (const line of wordWrap(text, cols)) lines.push(bgLine(`${fg}${line}`, cols, bg))
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
	const lines = [bgLine(`${fg}${buildHeader(blockLabel(block), formatHHMM(block.ts), blobRef, cols)}`, cols, bg)]
	for (const line of blockContent(block, cols)) lines.push(bgLine(`${fg}${line}`, cols, bg))
	lines[lines.length - 1]! += FG_OFF
	if (hasStreamingHalCursor(block)) addInlineCursor(lines, block, cols, cursorVisible)
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
