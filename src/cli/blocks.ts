// Block rendering — convert history records to visual blocks, render to
// terminal lines with colored backgrounds and headers.
//
// A single assistant history record can produce multiple blocks:
//   thinking → tool₁ → tool₂ → assistant text
// The split happens in historyToBlocks(). Rendering is in renderBlock().

import { clipVisual, expandTabs, hardWrap, M_BOLD, M_BOLD_OFF, M_ITALIC, M_ITALIC_OFF, resolveMarkers, visLen, wordWrap } from '../utils/strings.ts'
import { ason } from '../utils/ason.ts'
import { models } from '../models.ts'
import { time } from '../utils/time.ts'
import type { HistoryEntry } from '../server/sessions.ts'
import { sessionEntry } from '../session/entry.ts'
import { STATE_DIR } from '../state.ts'
import { colors } from './colors.ts'
import { md, type MdColors } from './md.ts'
// Sibling import; circular with tool-specs.ts but safe per module convention —
// all access happens at call time, never at import time.
import { toolSpecs } from './tool-specs.ts'

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

interface LinkSpan { line: number; start: number; end: number; url: string }

const URL_RE = /https?:\/\/[^\s<>"']+/g
const TRAILING_URL_PUNCT = '.,!?;:)]}'

function firstWhitespaceIndex(s: string): number {
	for (let i = 0; i < s.length; i++) {
		if (/\s/.test(s[i]!)) return i
	}
	return -1
}

function trimTrailingUrlPunctuation(url: string, spans: LinkSpan[]): string {
	while (url && TRAILING_URL_PUNCT.includes(url.at(-1)!)) {
		url = url.slice(0, -1)
		const last = spans.at(-1)
		if (!last) break
		last.end--
		if (last.end <= last.start) spans.pop()
	}
	return url
}

function pushUrlSpans(spans: LinkSpan[], lines: string[], lineIndex: number, start: number, end: number, cols: number): void {
	let url = lines[lineIndex]!.slice(start, end)
	const urlSpans: LinkSpan[] = [{ line: lineIndex, start, end, url: '' }]
	let currentLine = lineIndex
	let currentEnd = end

	while (currentEnd === lines[currentLine]!.length && visLen(lines[currentLine]!) >= cols && currentLine + 1 < lines.length) {
		const next = lines[currentLine + 1]!
		if (!next || /^\s/.test(next) || /^https?:\/\//.test(next)) break
		const whitespace = firstWhitespaceIndex(next)
		if (whitespace >= 0) break
		url += next
		urlSpans.push({ line: currentLine + 1, start: 0, end: next.length, url: '' })
		currentLine++
		currentEnd = next.length
	}

	url = trimTrailingUrlPunctuation(url, urlSpans)
	if (!url || url === 'http://' || url === 'https://') return
	for (const span of urlSpans) {
		span.url = url
		spans.push(span)
	}
}

function osc8(url: string, label: string): string {
	return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`
}

function hyperlinkUrls(lines: string[], cols: number): string[] {
	const spans: LinkSpan[] = []
	for (let i = 0; i < lines.length; i++) {
		URL_RE.lastIndex = 0
		let match: RegExpExecArray | null
		while ((match = URL_RE.exec(lines[i]!))) {
			pushUrlSpans(spans, lines, i, match.index, match.index + match[0].length, cols)
		}
	}
	if (spans.length === 0) return lines

	const byLine = new Map<number, LinkSpan[]>()
	for (const span of spans) {
		const lineSpans = byLine.get(span.line) ?? []
		lineSpans.push(span)
		byLine.set(span.line, lineSpans)
	}

	const linked = lines.slice()
	for (const [lineIndex, lineSpans] of byLine) {
		lineSpans.sort((a, b) => b.start - a.start)
		let line = linked[lineIndex]!
		for (const span of lineSpans) {
			line = line.slice(0, span.start) + osc8(span.url, line.slice(span.start, span.end)) + line.slice(span.end)
		}
		linked[lineIndex] = line
	}
	return linked
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
				result.push({ type: entry.type, text: entry.text, ts, dimmed })
				break
			case 'error':
				result.push({ type: 'error', text: entry.text, blobId: entry.blobId, sessionId: blobOwner, ts, dimmed })
				break
			case 'turn_end':
				if (entry.status === 'failed' && result.at(-1)?.type !== 'error') result.push({ type: 'error', text: 'Generation failed.', ts, dimmed })
				if (entry.status === 'aborted') result.push({ type: 'log', text: '[paused]', ts, dimmed })
				break
			case 'forked_from':
				result.push({ type: 'fork', text: `Tab forked from ${entry.parent}.`, ts, dimmed })
				break
			case 'forked_to':
				result.push({ type: 'fork', text: `Tab forked to ${entry.child}.`, ts, dimmed })
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

const [FG_OFF, RESET_BG] = ['\x1b[39m', '\x1b[49m']

function pushWrapped(lines: string[], text: string, cols: number): void {
	for (const raw of text.split('\n')) for (const line of hardWrap(expandTabs(raw, blockConfig.tabWidth), cols)) lines.push(line)
}

function markdownColors(block: Extract<Block, { type: 'assistant' | 'thinking' | 'log' | 'info' | 'warning' | 'error' }>): MdColors {
	const palette = blockColors(block)
	return {
		bold: [M_BOLD, M_BOLD_OFF],
		italic: [M_ITALIC, M_ITALIC_OFF],
		code: palette.code ? [palette.code, palette.fg] : [palette.fg, palette.fg],
	}
}

function isTextCodeLang(lang: string): boolean {
	const normalized = lang.trim().toLowerCase()
	return normalized === 'text' || normalized === 'txt' || normalized === 'plain' || normalized === 'plaintext'
}

function pushCodeWrapped(lines: string[], text: string, cols: number, mdColors: MdColors, preserveWords: boolean): void {
	for (const raw of text.split('\n')) {
		const expanded = expandTabs(raw, blockConfig.tabWidth)
		const wrapped = preserveWords ? wordWrap(expanded, cols) : hardWrap(expanded, cols)
		for (const line of wrapped) {
			lines.push(`${mdColors.code[0]}${line}${mdColors.code[1]}`)
		}
	}
}

function renderMarkdownLines(block: Extract<Block, { type: 'assistant' | 'thinking' | 'log' | 'info' | 'warning' | 'error' }>, cols: number): string[] {
	const lines: string[] = []
	const mdColors = markdownColors(block)
	for (const span of md.mdSpans(markdownSourceText(block))) {
		if (span.type === 'code') {
			for (const raw of span.lines) pushCodeWrapped(lines, raw, cols, mdColors, isTextCodeLang(span.lang))
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
		const spec = toolSpecs.getToolSpec(block.name)
		const command = spec.command?.(block.input, block.output)
		if (command) lines.push(...formatToolCommand(command, cols, spec.shellContinuations?.(block.input, block.output) ?? block.name === 'bash'))
		const details = spec.details?.(block.input)
		if (details) pushWrapped(lines, details, cols)
		if (!block.output) return lines
		const output = sanitizeTerminalText(stripAnsiSequences(block.output))
		const format = spec.format?.(output, cols, block.input) ?? { bodyLines: [] }
		for (const line of format.bodyLines) lines.push(clipLine(line, cols))
		if (format.suppressOutput) return lines
		const outputLines = output.trimEnd().split('\n')
		if (outputLines.length > blockConfig.maxToolOutputLines) {
			const hidden = format.hiddenIndicator ?? `[+ ${outputLines.length - blockConfig.maxToolOutputLines} lines]`
			lines.push(hidden)
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

function blockColors(block: Block): { fg: string; bg: string; bgIsBlack?: boolean; bold?: string; code?: string } {
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
	const prefix = time ? ` ${time} ` : ' '
	const right = blobRef ? ` (${blobRef}) ` : ''
	const titleWidth = Math.max(1, cols - visLen(prefix) - visLen(right))
	const left = `${prefix}${clipVisual(title, titleWidth)}`
	return `${left}${' '.repeat(Math.max(0, cols - visLen(left) - visLen(right)))}${right}`
}

function padBlockLine(line: string): string {
	return ` ${line}`
}

function padBlock(lines: string[], fg: string, bg: string, bgIsBlack: boolean | undefined, cols: number): void {
	if (!bg || bgIsBlack) return
	lines.unshift(bgLine(`${fg} `, cols, bg))
	lines.push(bgLine(`${fg} `, cols, bg))
}

const fixedLabels = { log: 'Log', info: 'System', warning: 'Warning', error: 'Error', fork: 'Fork' }

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
	if (block.type === 'tool') return toolSpecs.getToolSpec(block.name).title?.(block.input, block.output) ?? toolSpecs.humanizeName(block.name)
	return fixedLabels[block.type]
}

function inlineNoticeText(block: Block): string | undefined {
	if (block.type !== 'log' && block.type !== 'info' && block.type !== 'fork') return undefined
	const text = expandTabs(sanitizeTerminalText(stripAnsiSequences(block.text)), blockConfig.tabWidth).trim()
	if (!text || text.includes('\n')) return undefined
	if (text.includes('`')) return undefined
	if ((block.type === 'log' || block.type === 'info') && !/^\[[^\]\n]+\]$/.test(text)) return undefined
	if (visLen(text) > 50) return undefined
	return text
}

function renderInlineNoticeBlock(block: Block, cols: number): string[] | undefined {
	const text = inlineNoticeText(block)
	if (!text) return undefined
	const blobRef = 'blobId' in block && 'sessionId' in block && block.blobId && block.sessionId ? `${block.sessionId}/${block.blobId}` : ''
	if (blobRef) return undefined
	const { fg, bg } = blockColors(block)
	const header = buildHeader(`${blockLabel(block)}: ${text}`, formatBlockTime(block.ts), '', cols)
	return [`${bgLine(`${fg}${header}`, cols, bg)}${FG_OFF}`]
}

function renderBlockGroup(group: Array<Extract<Block, { type: 'log' | 'info' | 'warning' | 'error' }>>, cols: number): string[] {
	if (group.length === 0) return []
	if (group.length === 1) return renderBlock(group[0]!, cols)
	const inlineLines: string[] = []
	let allInline = true
	for (const block of group) {
		const rendered = renderInlineNoticeBlock(block, cols)
		if (!rendered) {
			allInline = false
			break
		}
		inlineLines.push(...rendered)
	}
	if (allInline) return inlineLines

	const first = group[0]!
	const last = group[group.length - 1]!
	const label = fixedLabels[first.type]
	const header = buildHeader(label, formatBlockTimeRange(first.ts, last.ts), '', cols)
	const { fg, bg, bgIsBlack } = blockColors(first)
	const lines = [bgLine(`${fg}${header}`, cols, bg)]
	const contentCols = Math.max(1, cols - 1)
	let hasContent = false
	for (const block of group) {
		const content = hyperlinkUrls(renderMarkdownLines(block, contentCols), contentCols)
		if (content.length > 0 && !hasContent) {
			lines.push(bgLine(`${fg} `, cols, bg))
			hasContent = true
		}
		for (const line of content) lines.push(bgLine(`${fg}${padBlockLine(line)}`, cols, bg))
	}
	padBlock(lines, fg, bg, bgIsBlack, cols)
	lines[lines.length - 1]! += FG_OFF
	return lines
}

function hasStreamingHalCursor(block: Block): boolean {
	return (block.type === 'assistant' || block.type === 'thinking') && !!block.streaming
}

function cursorColor(block?: Block): string {
	if (block?.type === 'thinking') return colors.thinking.cursor ?? colors.thinking.fg
	return colors.assistant.cursor ?? colors.assistant.fg
}

function idleCursorColor(): string {
	return colors.assistant.cursorIdle ?? colors.assistant.cursor ?? colors.assistant.fg
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
	const inlineNotice = renderInlineNoticeBlock(block, cols)
	if (inlineNotice) return inlineNotice

	const blobRef =
		'blobId' in block && 'sessionId' in block && block.blobId && block.sessionId
			? `${block.sessionId}/${block.blobId}`
			: ''
	const { fg, bg, bgIsBlack } = blockColors(block)
	const label = blockLabel(block)
	const blockTime = formatBlockTime(block.ts)
	const header = buildHeader(label, blockTime, blobRef, cols)
	const lines = [bgLine(`${fg}${header}`, cols, bg)]
	const contentCols = Math.max(1, cols - 1)
	const content = hyperlinkUrls(blockContent(block, contentCols), contentCols)
	if (content.length > 0) lines.push(bgLine(`${fg} `, cols, bg))
	for (const line of content) {
		lines.push(bgLine(`${fg}${padBlockLine(line)}`, cols, bg))
	}
	// Streaming cursors are progress markers, not idle blinkers: keep them solid
	// so the active streamed block is always visually anchored.
	if (hasStreamingHalCursor(block)) addInlineCursor(lines, block, cols, true)
	padBlock(lines, fg, bg, bgIsBlack, cols)
	lines[lines.length - 1]! += FG_OFF
	return lines
}

export const blocks = {
	config: blockConfig,
	historyToBlocks,
	touch,
	renderBlock,
	cursorColor,
	idleCursorColor,
	renderBlockGroup,
	loadBlobs,
}
