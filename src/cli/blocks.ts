// Block rendering — paint Block objects (see block-data.ts) as terminal
// lines with colored backgrounds, headers, markdown bodies and streaming
// cursors. Text sanitization/hyperlinking lives in block-text.ts and
// per-tool display logic in tool-specs.ts.

import { clipVisual, expandTabs, hardWrap, M_BOLD, M_BOLD_OFF, M_ITALIC, M_ITALIC_OFF, resolveMarkers, visLen, wordWrap } from '../utils/strings.ts'
import { models } from '../models.ts'
import { time } from '../utils/time.ts'
import { colors } from './colors.ts'
import { md, type MdColors } from './md.ts'
import { blockText } from './block-text.ts'
// Sibling import; circular with tool-specs.ts but safe per module convention —
// all access happens at call time, never at import time.
import { toolSpecs } from './tool-specs.ts'

const blockConfig = {
	tabWidth: 4,
	blobBatchSize: 64,
	maxToolOutputLines: 20,
	maxEditDiffLines: 3,
}

// Block type lives in block-data.ts; re-exported so renderers can keep
// importing it from blocks.ts.
export type { Block } from './block-data.ts'
import type { Block } from './block-data.ts'

function markdownSourceText(block: Exclude<Block, { type: 'tool' | 'user' | 'fork' }>): string {
	const text =
		block.type === 'log' || block.type === 'info' || block.type === 'warning' || block.type === 'error'
			? blockText.stripAnsiSequences(block.text)
			: block.text
	return blockText.sanitizeTerminalText(text)
}

const [FG_OFF, RESET_BG, STRIKE, STRIKE_OFF] = ['\x1b[39m', '\x1b[49m', '\x1b[9m', '\x1b[29m']

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
		const output = blockText.sanitizeTerminalText(blockText.stripAnsiSequences(block.output))
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
	for (const raw of expandTabs(blockText.sanitizeTerminalText(block.text), blockConfig.tabWidth).split('\n')) {
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
		if (block.canceled) return 'You (canceled)'
		if (block.source && block.source !== 'user' && block.source !== 'system') return `Inbox · ${block.source}`
		if (block.status === 'editing') return 'You (editing this prompt)'
		if (block.status === 'steering') return 'You (steering)'
		if (block.status === 'queued') return 'You (queued)'
		return 'You'
	}
	if (block.type === 'assistant') {
		const display = models.displayModel(block.model)
		if (display && block.synthetic && block.canceled) return `Hal (${display}, synthetic, canceled)`
		if (display && block.synthetic) return `Hal (${display}, synthetic)`
		if (display && block.canceled) return `Hal (${display}, canceled)`
		if (display) return `Hal (${display})`
		if (block.synthetic && block.canceled) return 'Hal (synthetic, canceled)'
		if (block.canceled) return 'Hal (canceled)'
		return block.synthetic ? 'Hal (synthetic)' : 'Hal'
	}
	if (block.type === 'thinking') {
		const display = models.displayModel(block.model)
		const effort = block.thinkingEffort ?? models.reasoningEffort(block.model)
		if (display && effort && block.canceled) return `Hal (${display}, thinking ${effort}, canceled)`
		if (display && effort) return `Hal (${display}, thinking ${effort})`
		if (display && block.canceled) return `Hal (${display}, thinking, canceled)`
		if (display) return `Hal (${display}, thinking)`
		return block.canceled ? 'Thinking (canceled)' : 'Thinking'
	}
	if (block.type === 'tool') {
		const title = toolSpecs.getToolSpec(block.name).title?.(block.input, block.output) ?? toolSpecs.humanizeName(block.name)
		return block.canceled ? `${title} (canceled)` : title
	}
	return fixedLabels[block.type]
}

function inlineNoticeText(block: Block): string | undefined {
	if (block.type !== 'log' && block.type !== 'info' && block.type !== 'fork') return undefined
	const text = expandTabs(blockText.sanitizeTerminalText(blockText.stripAnsiSequences(block.text)), blockConfig.tabWidth).trim()
	const marker = text.match(/^\[([^\]\n]+)\]$/)
	if (!text || text.includes('\n')) return undefined
	if (text.includes('`')) return undefined
	if ((block.type === 'log' || block.type === 'info') && !marker) return undefined
	if (visLen(text) > 50) return undefined
	if (marker) return `${marker[1]!.slice(0, 1).toUpperCase()}${marker[1]!.slice(1)}`
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
		const content = blockText.hyperlinkUrls(renderMarkdownLines(block, contentCols), contentCols)
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
	const content = blockText.hyperlinkUrls(blockContent(block, contentCols), contentCols)
	if (content.length > 0) lines.push(bgLine(`${fg} `, cols, bg))
	for (const line of content) {
		const text = block.canceled ? `${STRIKE}${line}${STRIKE_OFF}` : line
		const body = padBlockLine(text)
		lines.push(bgLine(`${fg}${body}`, cols, bg))
	}
	// Streaming cursors blink on the shared pulse so active output feels alive
	// without adding a separate rendering clock.
	if (hasStreamingHalCursor(block)) addInlineCursor(lines, block, cols, cursorVisible)
	padBlock(lines, fg, bg, bgIsBlack, cols)
	lines[lines.length - 1]! += FG_OFF
	return lines
}

export const blocks = {
	config: blockConfig,
	renderBlock,
	cursorColor,
	idleCursorColor,
	renderBlockGroup,
}
