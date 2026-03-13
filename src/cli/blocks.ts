// Block-based content model for tab output.

import * as colors from './colors.ts'
import { strings } from '../utils/strings.ts'
import { md } from './md.ts'
import { models } from '../models.ts'
import { config } from '../config.ts'
import { ason } from '../utils/ason.ts'
import {
	TOOL_MAX_OUTPUT, THINKING_BLOCK_MIN_LINES, THINKING_BLOCK_MAX_LINES,
	BLOCK_MARGIN, collapseBlankLines, oneLine, contentWidth, boxLine,
	plainLine, toolHeader, elapsed, formatBlockTime, innerWidth, clipAnsi, expandTabs,
} from './block-layout.ts'
import { bash } from '../tools/bash.ts'

export type Block =
	| { type: 'input'; text: string; model?: string; source?: string; status?: 'queued' | 'steering'; ts?: number }
	| { type: 'assistant'; text: string; done: boolean; model?: string; ts?: number }
	| { type: 'thinking'; text: string; done: boolean; blobId?: string; model?: string; sessionId?: string; ts?: number }
	| { type: 'info'; text: string; ts?: number }
	| { type: 'error'; text: string; detail?: string; blobId?: string; ts?: number }
	| {
		type: 'tool'
		toolId?: string
		name: string
		status: 'streaming' | 'running' | 'done' | 'error'
		args: string
		output: string
		startTime: number
		endTime?: number
		blobId?: string
		sessionId: string
		ts?: number
	}

function effectiveModel(model?: string): string {
	return model || config.getConfig().defaultModel
}

function renderInput(block: Extract<Block, { type: 'input' }>, width: number): string[] {
	const isSystem = block.text.startsWith('[system] ')
	const text = isSystem ? block.text.slice(9) : block.text
	const who = isSystem ? 'System' : (block.source && block.source !== 'user' ? block.source : 'You')
	const { fg, bg } = isSystem ? colors.system : colors.input
	const status = block.status ? ` (${block.status})` : ''
	const model = !isSystem && block.model ? ` (to ${models.displayModel(block.model)})` : ''
	const label = `${who}${status}${model}`
	if (block.status) return [boxLine(`${label}: ${text}`, width, fg, bg)]
	const header = toolHeader(label, width, fg, bg, undefined, '', block.ts)
	const body = strings.wordWrap(text, contentWidth(width)).map(l => boxLine(l, width, fg, bg))
	return [...header, ...body]
}

function renderAssistant(block: Extract<Block, { type: 'assistant' }>, width: number): string[] {
	const text = collapseBlankLines(block.text.replace(/^\s+/, '').trimEnd())
	if (!text) return []
	const label = `Hal (${models.displayModel(effectiveModel(block.model))})`
	const { fg, bg } = colors.assistant
	const mdColors = colors.assistantMd
	const header = toolHeader(label, width, fg, bg, undefined, '', block.ts)
	const cw = contentWidth(width)
	const line = (s: string) => boxLine(s, width, fg, bg)
	const body: string[] = []
	for (const span of md.mdSpans(text)) {
		if (span.type === 'code') {
			for (const l of span.lines) body.push(line(`${mdColors.code[0]}${l}${mdColors.code[1]}`))
		} else if (span.type === 'table') {
			for (const l of md.mdTable(span.lines)) body.push(line(md.mdInline(l, mdColors)))
		} else {
			for (const l of span.lines)
				for (const wl of strings.wordWrap(md.mdInline(l, mdColors), cw)) body.push(line(wl))
		}
	}
	return [...header, ...body]
}

function renderThinking(block: Extract<Block, { type: 'thinking' }>, width: number): string[] {
	const text = collapseBlankLines(block.text.trimEnd())
	if (!text) return [boxLine('Thinking...', width, colors.thinking.fg, colors.thinking.bg)]
	const mdColors = colors.thinkingMd
	const cw = contentWidth(width)
	const rawWrapped = strings.wordWrap(text, cw)
	if (rawWrapped.length < THINKING_BLOCK_MIN_LINES) {
		const lines: string[] = []
		for (const l of text.split('\n'))
			for (const wl of strings.wordWrap(md.mdInline(l, mdColors), cw)) lines.push(plainLine(wl, width, colors.thinking.fg))
		return lines
	}
	const label = `Hal (${models.displayModel(effectiveModel(block.model))}, thinking)`
	const header = toolHeader(label, width, colors.thinking.fg, colors.thinking.bg, block.blobId, block.sessionId ?? '', block.ts)
	const line = (s: string) => boxLine(s, width, colors.thinking.fg, colors.thinking.bg)
	const body: string[] = []
	for (const span of md.mdSpans(text)) {
		if (span.type === 'code') {
			for (const l of span.lines) body.push(line(`${mdColors.code[0]}${l}${mdColors.code[1]}`))
		} else if (span.type === 'table') {
			for (const l of md.mdTable(span.lines)) body.push(line(md.mdInline(l, mdColors)))
		} else {
			for (const l of span.lines)
				for (const wl of strings.wordWrap(md.mdInline(l, mdColors), cw)) body.push(line(wl))
		}
	}
	if (body.length > THINKING_BLOCK_MAX_LINES) {
		const hidden = body.length - THINKING_BLOCK_MAX_LINES
		return [...header, line(`[+ ${hidden} lines]`), ...body.slice(-THINKING_BLOCK_MAX_LINES)]
	}
	return [...header, ...body]
}

function boxLineWithTime(text: string, width: number, fg: string, bg: string, ts?: number): string {
	const iw = innerWidth(width)
	const timeStr = ` ${formatBlockTime(ts)} `
	const maxContent = iw - timeStr.length
	const raw = ' '.repeat(BLOCK_MARGIN) + expandTabs(text.replace(/\r/g, ''))
	const clipped = clipAnsi(raw, maxContent)
	const pad = Math.max(0, maxContent - strings.visLen(clipped))
	return `${' '.repeat(BLOCK_MARGIN)}${bg}${fg}${clipped}${' '.repeat(pad)}${timeStr}${colors.RESET}${' '.repeat(BLOCK_MARGIN)}`
}

function renderInfo(block: Extract<Block, { type: 'info' }>, width: number): string[] {
	const { fg, bg } = colors.info
	const lines = block.text.split('\n')
	if (lines.length === 1) return [boxLineWithTime(lines[0], width, fg, bg, block.ts)]
	return [
		boxLineWithTime(lines[0], width, fg, bg, block.ts),
		...lines.slice(1).map(l => boxLine(l, width, fg, bg)),
	]
}

function formatErrorDetail(detail: string): string {
	const jsonStart = detail.indexOf('{')
	if (jsonStart >= 0) {
		try {
			const parsed = JSON.parse(detail.slice(jsonStart))
			const prefix = detail.slice(0, jsonStart).trim()
			const formatted = ason.stringify(parsed)
			return prefix ? `${prefix}\n${formatted}` : formatted
		} catch {}
	}
	return detail
}

function renderError(block: Extract<Block, { type: 'error' }>, width: number): string[] {
	const { fg, bg } = colors.error
	const header = toolHeader('Error', width, fg, bg, block.blobId, '', block.ts)
	const raw = block.detail ? formatErrorDetail(block.detail) : block.text
	const body = strings.wordWrap(raw, contentWidth(width)).map(l => boxLine(l, width, fg, bg))
	return [...header, ...body]
}

function renderTool(block: Extract<Block, { type: 'tool' }>, width: number): string[] {
	const { fg, bg } = colors.tool(block.name)
	const time = elapsed(block.startTime, block.endTime)
	const args = oneLine(block.args)
	let label = ''
	let prelude: string[] = []
	let outputLines: string[] = []
	let hiddenOutputLines = 0
	if (block.name === 'bash') {
		const view = bash.formatBlock({
			command: args,
			status: block.status,
			elapsed: time,
			output: block.output,
			commandWidth: contentWidth(width),
			maxOutputLines: TOOL_MAX_OUTPUT,
		})
		label = view.label
		prelude = view.commandLines
		outputLines = view.outputLines
		hiddenOutputLines = view.hiddenOutputLines
	} else {
		const statusSuffix = block.status === 'error' ? ' ✗' : block.status === 'done' ? ' ✓' : ''
		label = `${block.name}: ${args} (${time})${statusSuffix}`
		const outputText = block.output.trimEnd()
		if (outputText) outputLines = outputText.split('\n').map((line) => line.replace(/\r/g, ''))
		if (outputLines.length > TOOL_MAX_OUTPUT) {
			hiddenOutputLines = outputLines.length - TOOL_MAX_OUTPUT
			outputLines = outputLines.slice(-TOOL_MAX_OUTPUT)
		}
	}
	const lines = [...toolHeader(label, width, fg, bg, block.blobId, block.sessionId, block.ts)]
	for (const line of prelude) lines.push(boxLine(line, width, fg, bg))
	if (hiddenOutputLines > 0) lines.push(boxLine(`[+ ${hiddenOutputLines} lines]`, width, fg, bg))
	for (const line of outputLines) lines.push(boxLine(line, width, fg, bg))
	return lines
}

function renderBlock(block: Block, width: number): string[] {
	switch (block.type) {
		case 'input':
			return renderInput(block, width)
		case 'assistant':
			return renderAssistant(block, width)
		case 'thinking':
			return renderThinking(block, width)
		case 'info':
			return renderInfo(block, width)
		case 'error':
			return renderError(block, width)
		case 'tool':
			return renderTool(block, width)
	}
}

function isStreaming(block: Block): boolean {
	if ((block.type === 'assistant' || block.type === 'thinking') && !block.done) return true
	if (block.type === 'tool' && (block.status === 'streaming' || block.status === 'running')) return true
	return false
}

/** Cursor color: matches the last active block's color scheme. */
function cursorColor(block: Block): string {
	if (block.type === 'tool') return colors.tool(block.name).fg
	if (block.type === 'thinking') return colors.thinking.fg
	return colors.cursor.fg
}

/** Insert cursor into last rendered line without breaking bg color or exceeding width.
 *  Returns the lines and the column where the cursor was placed. */
function inlineCursor(line: string, cc: string, visible: boolean, width: number): { lines: string[]; col: number } {
	const cursorChar = visible ? `${cc}█` : ' '
	const resetAt = line.lastIndexOf(colors.RESET)
	if (resetAt >= 0) {
		const beforeReset = line.slice(0, resetAt)
		const afterReset = line.slice(resetAt + colors.RESET.length)
		if (/^ +$/.test(afterReset)) {
			const pad = beforeReset.match(/ +$/)?.[0] ?? ''
			if (pad.length > 0) {
				const before = beforeReset.slice(0, -pad.length)
				const col = strings.visLen(before)
				return { lines: [before + cursorChar + pad.slice(1) + colors.RESET + afterReset], col }
			}
		}
	}
	const hasReset = line.endsWith(colors.RESET)
	const body = hasReset ? line.slice(0, -colors.RESET.length) : line
	const trail = body.match(/ +$/)?.[0] ?? ''
	if (trail.length > 0) {
		const before = body.slice(0, -trail.length)
		const col = strings.visLen(before)
		return { lines: [before + cursorChar + trail.slice(1) + (hasReset ? colors.RESET : '')], col }
	}
	if (strings.visLen(body) >= width) {
		return { lines: [line, visible ? `${cc}█${colors.RESET}` : ' '], col: 0 }
	}
	const col = strings.visLen(body)
	return { lines: [body + cursorChar + (hasReset ? colors.RESET : '')], col }
}

/** Render all blocks with one blank line between them.
 *  After the last block: empty line, cursor line, empty line (always).
 *  During streaming: cursor inlined in last block line, then one empty line.
 *  Returns lines and optional streamCursor (row/col of the inline cursor during streaming). */
export function renderBlocks(blocks: Block[], width: number, cursorVisible = false): { lines: string[]; streamCursor?: { row: number; col: number } } {
	const result: string[] = []
	for (const block of blocks) {
		const lines = renderBlock(block, width)
		if (lines.length === 0) continue
		if (result.length > 0) result.push('')
		result.push(...lines)
	}
	const lastBlock = blocks[blocks.length - 1]
	const streaming = lastBlock && isStreaming(lastBlock)
	if (streaming && result.length > 0) {
		// Cursor always visible (solid) during streaming
		const cc = cursorColor(lastBlock)
		const { lines: extra, col } = inlineCursor(result[result.length - 1], cc, true, width)
		const cursorRow = result.length - 1 + (extra.length > 1 ? 1 : 0)
		result.splice(result.length - 1, 1, ...extra)
		result.push('')
		return { lines: result, streamCursor: { row: cursorRow, col } }
	} else {
		// Idle: empty line, cursor line, empty line
		const cc = colors.cursor.fg
		const c = cursorVisible ? `${cc}█${colors.RESET}` : ' '
		result.push('')
		result.push(`${' '.repeat(BLOCK_MARGIN)}${c}`)
		result.push('')
	}
	return { lines: result }
}

/** Render a question block (tool-like box above the tab bar). */
export function renderQuestion(question: string, width: number): string[] {
	const { fg, bg } = colors.question
	const aFg = colors.assistant.fg
	const header = toolHeader('Hal is asking you a question', width, fg, bg, undefined, '', Date.now())
	const body = strings.wordWrap(question, contentWidth(width)).map(l => boxLine(l, width, aFg, bg))
	return [...header, ...body]
}

export const blocks = { renderBlocks, renderQuestion }
