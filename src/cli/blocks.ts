// Block-based content model for tab output.

import * as colors from './colors.ts'
import { charWidth, visLen, wordWrap } from '../utils/strings.ts'
import { mdSpans, mdInline, mdTable } from './md.ts'
import { displayModel } from '../models.ts'
import { getConfig } from '../config.ts'
import { stringify as asonStringify } from '../utils/ason.ts'
import { blocksDir } from '../state.ts'

const TOOL_MAX_OUTPUT = 5
const THINKING_BLOCK_MIN_LINES = 5
const THINKING_BLOCK_MAX_LINES = 10
const BASH_HEADER_INLINE_MAX = 60
const BLOCK_MARGIN = 1
const BLOCK_PAD = 1
const TAB_WIDTH = 4

export type Block =
	| { type: 'input'; text: string; model?: string; source?: string; status?: 'queued' | 'steering' }
	| { type: 'assistant'; text: string; done: boolean; model?: string }
	| { type: 'thinking'; text: string; done: boolean; ref?: string; model?: string; sessionId?: string }
	| { type: 'info'; text: string }
	| { type: 'error'; text: string; detail?: string; ref?: string }
	| {
		type: 'tool'
		name: string
		status: 'streaming' | 'running' | 'done' | 'error'
		args: string
		output: string
		startTime: number
		endTime?: number
		ref?: string
		sessionId: string
	}

/** Collapse runs of 3+ newlines to 2 (preserving paragraph breaks). */
function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, '\n\n')
}

function oneLine(text: string): string {
	return text.replace(/\s*\r?\n+\s*/g, ' ').replace(/\s+/g, ' ').trim()
}

function effectiveModel(model?: string): string {
	return model || getConfig().defaultModel
}

/** Expand tabs to spaces (tab stops at TAB_WIDTH columns). */
function expandTabs(s: string): string {
	let col = 0
	let out = ''
	for (const ch of s) {
		if (ch === '\t') {
			const spaces = TAB_WIDTH - (col % TAB_WIDTH)
			out += ' '.repeat(spaces)
			col += spaces
		} else {
			out += ch
			col++
		}
	}
	return out
}

function innerWidth(width: number): number {
	return Math.max(1, width - 2 * BLOCK_MARGIN)
}

function contentWidth(width: number): number {
	return Math.max(1, innerWidth(width) - 2 * BLOCK_PAD)
}

function clipAnsi(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return ''
	if (visLen(text) <= maxWidth) return text
	if (maxWidth === 1) return '…'
	const limit = maxWidth - 1
	let out = ''
	let vis = 0
	let esc = false
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (ch === '\x1b') {
			esc = true
			out += ch
			continue
		}
		if (esc) {
			out += ch
			if (ch === 'm') esc = false
			continue
		}
		const cp = text.codePointAt(i)!
		const cl = cp > 0xffff ? 2 : 1
		const w = charWidth(cp)
		if (vis + w > limit) break
		out += text.slice(i, i + cl)
		vis += w
		if (cl === 2) i++
	}
	return out + '…'
}

function clipPlain(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return ''
	if (text.length <= maxWidth) return text
	if (maxWidth === 1) return '…'
	return text.slice(0, maxWidth - 1) + '…'
}

function boxLine(text: string, width: number, fg: string, bg: string): string {
	const iw = innerWidth(width)
	const raw = ' '.repeat(BLOCK_PAD) + expandTabs(text.replace(/\r/g, ''))
	const clipped = clipAnsi(raw, iw)
	const pad = Math.max(0, iw - visLen(clipped))
	return `${' '.repeat(BLOCK_MARGIN)}${bg}${fg}${clipped}${' '.repeat(pad)}${colors.RESET}${' '.repeat(BLOCK_MARGIN)}`
}

function plainLine(text: string, width: number, fg: string): string {
	const iw = innerWidth(width)
	const clipped = clipAnsi(expandTabs(text.replace(/\r/g, '')), iw)
	const pad = Math.max(0, iw - visLen(clipped))
	return `${' '.repeat(BLOCK_MARGIN)}${fg}${clipped}${' '.repeat(pad)}${colors.RESET}${' '.repeat(BLOCK_MARGIN)}`
}

function headerLine(text: string, width: number, fg: string, bg: string): string {
	const iw = innerWidth(width)
	const vw = visLen(text)
	const pad = Math.max(0, iw - vw)
	return `${' '.repeat(BLOCK_MARGIN)}${bg}${fg}${text}${' '.repeat(pad)}${colors.RESET}${' '.repeat(BLOCK_MARGIN)}`
}

function toolHeader(label: string, width: number, fg: string, bg: string, ref: string | undefined, sessionId: string): string[] {
	const iw = innerWidth(width)
	const safeLabel = oneLine(label)
	const displayRef = ref ? (sessionId ? `${sessionId}/${ref}` : ref) : ''
	const safeRef = displayRef ? clipPlain(oneLine(displayRef), 24) : ''
	let refDisplay = ''
	if (safeRef && ref) {
		const fileUrl = `file://${blocksDir(sessionId)}/${ref}.ason`
		refDisplay = ` [\x1b]8;;${fileUrl}\x07${safeRef}\x1b]8;;\x07] ──`
	}
	const prefix = '── '
	const maxLabel = Math.max(1, iw - prefix.length - (safeRef ? safeRef.length + 6 : 0) - 2)
	const shown = clipPlain(safeLabel, maxLabel)
	const lead = `${prefix}${shown} `
	const fill = '─'.repeat(Math.max(1, iw - lead.length - (safeRef ? safeRef.length + 6 : 0)))
	return [headerLine(lead + fill + refDisplay, width, fg, bg)]
}

function elapsed(startTime: number, endTime?: number): string {
	const s = ((endTime ?? Date.now()) - startTime) / 1000
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

function renderInput(block: Extract<Block, { type: 'input' }>, width: number): string[] {
	const isSystem = block.text.startsWith('[system] ')
	const text = isSystem ? block.text.slice(9) : block.text
	const who = isSystem ? 'System' : (block.source && block.source !== 'user' ? block.source : 'You')
	const { fg, bg } = isSystem ? colors.system : colors.input
	const status = block.status ? ` (${block.status})` : ''
	const model = !isSystem && block.model ? ` (to ${displayModel(block.model)})` : ''
	const label = `${who}${status}${model}`
	if (block.status) return [boxLine(`${label}: ${text}`, width, fg, bg)]
	const header = toolHeader(label, width, fg, bg)
	const body = wordWrap(text, contentWidth(width)).map(l => boxLine(l, width, fg, bg))
	return [...header, ...body]
}

function renderAssistant(block: Extract<Block, { type: 'assistant' }>, width: number): string[] {
	const text = collapseBlankLines(block.text.replace(/^\s+/, '').trimEnd())
	if (!text) return []
	const label = `Hal (${displayModel(effectiveModel(block.model))})`
	const { fg, bg } = colors.assistant
	const md = colors.assistantMd
	const header = toolHeader(label, width, fg, bg)
	const cw = contentWidth(width)
	const line = (s: string) => boxLine(s, width, fg, bg)
	const body: string[] = []
	for (const span of mdSpans(text)) {
		if (span.type === 'code') {
			for (const l of span.lines) body.push(line(`${md.code[0]}${l}${md.code[1]}`))
		} else if (span.type === 'table') {
			for (const l of mdTable(span.lines)) body.push(line(mdInline(l, md)))
		} else {
			for (const l of span.lines)
				for (const wl of wordWrap(mdInline(l, md), cw)) body.push(line(wl))
		}
	}
	return [...header, ...body]
}

function renderThinking(block: Extract<Block, { type: 'thinking' }>, width: number): string[] {
	const text = collapseBlankLines(block.text.trimEnd())
	if (!text) return [boxLine('Thinking...', width, colors.thinking.fg, colors.thinking.bg)]
	const md = colors.thinkingMd
	const cw = contentWidth(width)
	const rawWrapped = wordWrap(text, cw)
	if (rawWrapped.length < THINKING_BLOCK_MIN_LINES) {
		const lines: string[] = []
		for (const l of text.split('\n'))
			for (const wl of wordWrap(mdInline(l, md), cw)) lines.push(plainLine(wl, width, colors.thinking.fg))
		return lines
	}
	const label = `Hal (${displayModel(effectiveModel(block.model))}, thinking)`
	const header = toolHeader(label, width, colors.thinking.fg, colors.thinking.bg, block.ref, block.sessionId ?? '')
	const line = (s: string) => boxLine(s, width, colors.thinking.fg, colors.thinking.bg)
	const body: string[] = []
	for (const span of mdSpans(text)) {
		if (span.type === 'code') {
			for (const l of span.lines) body.push(line(`${md.code[0]}${l}${md.code[1]}`))
		} else if (span.type === 'table') {
			for (const l of mdTable(span.lines)) body.push(line(mdInline(l, md)))
		} else {
			for (const l of span.lines)
				for (const wl of wordWrap(mdInline(l, md), cw)) body.push(line(wl))
		}
	}
	if (body.length > THINKING_BLOCK_MAX_LINES) {
		const hidden = body.length - THINKING_BLOCK_MAX_LINES
		return [...header, line(`[+ ${hidden} lines]`), ...body.slice(-THINKING_BLOCK_MAX_LINES)]
	}
	return [...header, ...body]
}

function renderInfo(block: Extract<Block, { type: 'info' }>, width: number): string[] {
	const { fg, bg } = colors.info
	return block.text.split('\n').map(l => boxLine(l, width, fg, bg))
}

function formatErrorDetail(detail: string): string {
	const jsonStart = detail.indexOf('{')
	if (jsonStart >= 0) {
		try {
			const parsed = JSON.parse(detail.slice(jsonStart))
			const prefix = detail.slice(0, jsonStart).trim()
			const formatted = asonStringify(parsed)
			return prefix ? `${prefix}\n${formatted}` : formatted
		} catch {}
	}
	return detail
}

function renderError(block: Extract<Block, { type: 'error' }>, width: number): string[] {
	const { fg, bg } = colors.error
	const header = toolHeader('Error', width, fg, bg, block.ref)
	const raw = block.detail ? formatErrorDetail(block.detail) : block.text
	const body = wordWrap(raw, contentWidth(width)).map(l => boxLine(l, width, fg, bg))
	return [...header, ...body]
}

function bashStatus(status: 'streaming' | 'running' | 'done' | 'error'): string {
	switch (status) {
		case 'done':
			return '✓'
		case 'error':
			return '✗'
		default:
			return '…'
	}
}

function wrapBashCommand(cmd: string, width: number): string[] {
	const max = Math.max(1, width)
	if (cmd.length <= max) return [cmd]
	const out: string[] = []
	let rest = cmd
	const suffix = ' \\'
	const take = Math.max(1, max - suffix.length)
	while (rest.length > max) {
		out.push(rest.slice(0, take) + suffix)
		rest = rest.slice(take)
	}
	out.push(rest)
	return out
}

function renderTool(block: Extract<Block, { type: 'tool' }>, width: number): string[] {
	const { fg, bg } = colors.tool(block.name)
	const time = elapsed(block.startTime, block.endTime)
	const args = oneLine(block.args)
	let label = ''
	const prelude: string[] = []
	if (block.name === 'bash') {
		if (args.length > BASH_HEADER_INLINE_MAX) {
			label = `bash: (${time}) ${bashStatus(block.status)}`
			prelude.push(...wrapBashCommand(args, contentWidth(width)))
		} else {
			label = `bash: ${args} (${time}) ${bashStatus(block.status)}`
		}
	} else {
		const statusSuffix = block.status === 'error' ? ' ✗' : block.status === 'done' ? ' ✓' : ''
		label = `${block.name}: ${args} (${time})${statusSuffix}`
	}
	const lines = [...toolHeader(label, width, fg, bg, block.ref, block.sessionId)]
	for (const l of prelude) lines.push(boxLine(l, width, fg, bg))
	const outputText = block.output.trimEnd()
	if (!outputText) return lines
	const outputLines = outputText.split('\n').map(l => l.replace(/\r/g, ''))
	if (outputLines.length > TOOL_MAX_OUTPUT) {
		const hidden = outputLines.length - TOOL_MAX_OUTPUT
		lines.push(boxLine(`[+ ${hidden} lines]`, width, fg, bg))
		for (const l of outputLines.slice(-TOOL_MAX_OUTPUT)) lines.push(boxLine(l, width, fg, bg))
		return lines
	}
	for (const l of outputLines) lines.push(boxLine(l, width, fg, bg))
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
	return colors.cursor.fg
}

/** Insert cursor into last rendered line without breaking bg color or exceeding width.
 *  Returns the lines and the column where the cursor was placed. */
function inlineCursor(line: string, cc: string, visible: boolean, width: number): { lines: string[]; col: number } {
	const hasReset = line.endsWith(colors.RESET)
	const body = hasReset ? line.slice(0, -colors.RESET.length) : line
	const trail = body.match(/ +$/)?.[0] ?? ''
	if (trail.length > 0) {
		const before = body.slice(0, -trail.length)
		const col = visLen(before)
		const cursorChar = visible ? `${cc}█` : ' '
		return { lines: [before + cursorChar + trail.slice(1) + (hasReset ? colors.RESET : '')], col }
	}
	if (visLen(body) >= width) {
		return { lines: [line, visible ? `${cc}█${colors.RESET}` : ' '], col: 0 }
	}
	const col = visLen(body)
	const cursorChar = visible ? `${cc}█` : ' '
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
		const cc = lastBlock ? cursorColor(lastBlock) : colors.cursor.fg
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
	const header = toolHeader('Hal is asking you a question', width, fg, bg, undefined, '')
	const body = wordWrap(question, contentWidth(width)).map(l => boxLine(l, width, aFg, bg))
	return [...header, ...body]
}