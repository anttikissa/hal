// Block-based content model for tab output.

import * as colors from './colors.ts'
import { mdSpans, mdInline, mdTable, visLen, wordWrap } from './md.ts'

const TOOL_MAX_OUTPUT = 5
const BLOCK_PAD = 1
export type Block =
	| { type: 'input'; text: string; model?: string; source?: string; status?: 'queued' | 'steering' }
	| { type: 'assistant'; text: string; done: boolean; model?: string }
	| { type: 'thinking'; text: string; done: boolean }
	| { type: 'info'; text: string }
	| { type: 'tool'; name: string; status: 'streaming' | 'running' | 'done' | 'error';
		args: string; output: string; startTime: number; endTime?: number }

/** Collapse runs of 3+ newlines to 2 (preserving paragraph breaks). */
function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, '\n\n')
}

const TAB_WIDTH = 4

/** Expand tabs to spaces (tab stops at TAB_WIDTH columns). */
function expandTabs(s: string): string {
	let col = 0, out = ''
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
const CONTENT_W = (width: number) => width - 2 * BLOCK_PAD

function renderInput(block: Extract<Block, { type: 'input' }>, width: number): string[] {
	const who = block.source && block.source !== 'user' ? block.source : 'You'
	const status = block.status ? ` (${block.status})` : ''
	const model = block.model ? ` (to ${block.model})` : ''
	const label = `${who}${status}${model}`
	if (block.status) return [toolLine(label + ': ' + block.text, width, colors.input.fg, colors.input.bg)]
	const header = toolHeader(label, width, colors.input.fg, colors.input.bg)
	const body = wordWrap(block.text, CONTENT_W(width)).map(l => toolLine(l, width, colors.input.fg, colors.input.bg))
	return [...header, ...body]
}

function renderAssistant(block: Extract<Block, { type: 'assistant' }>, width: number): string[] {
	const text = collapseBlankLines(block.text.trimEnd())
	if (!text) return []
	const label = block.model ? `Hal (${block.model})` : 'Hal'
	const { fg, bg } = colors.assistant
	const header = toolHeader(label, width, fg, bg)
	const cw = CONTENT_W(width)
	const line = (s: string) => toolLine(s, width, fg, bg)
	const body: string[] = []
	for (const span of mdSpans(text)) {
		if (span.type === 'code') {
			for (const l of span.lines) body.push(line(`\x1b[2m${l}\x1b[22m`))
		} else if (span.type === 'table') {
			for (const l of mdTable(span.lines)) body.push(line(mdInline(l)))
		} else {
			for (const l of span.lines)
				for (const wl of wordWrap(mdInline(l), cw)) body.push(line(wl))
		}
	}
	return [...header, ...body]
}

function renderThinking(block: Extract<Block, { type: 'thinking' }>, width: number): string[] {
	const pad = ' '.repeat(BLOCK_PAD)
	const text = collapseBlankLines(block.text.trimEnd())
	if (!text) return [`${colors.thinking.fg}${pad}Thinking...${colors.RESET}`]
	return wordWrap(text, CONTENT_W(width)).map(l => `${colors.thinking.fg}${pad}${l}${colors.RESET}`)
}

function renderInfo(block: Extract<Block, { type: 'info' }>, width: number): string[] {
	const { fg, bg } = colors.info
	return [toolLine(block.text, width, fg, bg)]
}

function elapsed(startTime: number, endTime?: number): string {
	const s = ((endTime ?? Date.now()) - startTime) / 1000
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

function toolLine(text: string, width: number, fg: string, bg: string): string {
	const padded = ' '.repeat(BLOCK_PAD) + expandTabs(text)
	const vl = visLen(padded)
	if (vl > width) {
		// Truncate to width (ANSI-aware)
		let vis = 0, esc = false, cut = padded.length
		for (let i = 0; i < padded.length; i++) {
			if (padded[i] === '\x1b') { esc = true; continue }
			if (esc) { if (padded[i] === 'm') esc = false; continue }
			if (++vis >= width) { cut = i + 1; break }
		}
		return `${bg}${fg}${padded.slice(0, cut)}${colors.RESET}`
	}
	const pad = width - vl
	return `${bg}${fg}${padded}${' '.repeat(pad)}${colors.RESET}`
}

function headerLine(text: string, width: number, fg: string, bg: string): string {
	return `${bg}${fg}${text.padEnd(width)}${colors.RESET}`
}

function toolHeader(label: string, width: number, fg: string, bg: string): string[] {
	const prefix = '── '
	const inner = prefix + label + ' '
	if (inner.length >= width) {
		const full = prefix + label + ' '
		const lines: string[] = []
		for (let i = 0; i < full.length; i += width) {
			lines.push(full.slice(i, i + width))
		}
		const last = lines[lines.length - 1]
		lines[lines.length - 1] = last + '─'.repeat(Math.max(0, width - last.length))
		return lines.map(l => headerLine(l, width, fg, bg))
	}
	const fill = '─'.repeat(Math.max(0, width - inner.length))
	return [headerLine(inner + fill, width, fg, bg)]
}

function renderTool(block: Extract<Block, { type: 'tool' }>, width: number): string[] {
	const { fg, bg } = colors.tool(block.name)
	const time = elapsed(block.startTime, block.endTime)
	const statusSuffix = block.status === 'error' ? ' ✗' : block.status === 'done' ? ' ✓' : ''
	const label = `${block.name}: ${block.args} (${time})${statusSuffix}`
	const header = toolHeader(label, width, fg, bg)

	const outputText = block.output.trimEnd()
	if (!outputText) return header

	const outputLines = outputText.split('\n')
	const lines = [...header]

	if (outputLines.length > TOOL_MAX_OUTPUT) {
		const hidden = outputLines.length - TOOL_MAX_OUTPUT
		lines.push(toolLine(`[+ ${hidden} lines]`, width, fg, bg))
		for (const l of outputLines.slice(-TOOL_MAX_OUTPUT)) {
			lines.push(toolLine(l, width, fg, bg))
		}
	} else {
		for (const l of outputLines) {
			lines.push(toolLine(l, width, fg, bg))
		}
	}
	return lines
}

function renderBlock(block: Block, width: number): string[] {
	switch (block.type) {
		case 'input': return renderInput(block, width)
		case 'assistant': return renderAssistant(block, width)
		case 'thinking': return renderThinking(block, width)
		case 'info': return renderInfo(block, width)
		case 'tool': return renderTool(block, width)
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

/** Insert cursor into last rendered line without breaking bg color or exceeding width. */
function inlineCursor(line: string, cc: string, visible: boolean, width: number): string[] {
	const hasReset = line.endsWith(colors.RESET)
	const body = hasReset ? line.slice(0, -colors.RESET.length) : line
	const trail = body.match(/ +$/)?.[0] ?? ''
	if (trail.length > 0) {
		// Replace one trailing pad space with cursor char, keep bg active
		const before = body.slice(0, -trail.length)
		const cursorChar = visible ? `${cc}█` : ' '
		return [before + cursorChar + trail.slice(1) + (hasReset ? colors.RESET : '')]
	}
	if (visLen(body) >= width) {
		// Full-width line (e.g. header with ─ fill) — cursor on next line
		return [line, visible ? `${cc}█${colors.RESET}` : ' ']
	}
	// Short unpadded line — append cursor
	const cursorChar = visible ? `${cc}█` : ' '
	return [body + cursorChar + (hasReset ? colors.RESET : '')]
}

/** Render all blocks with one blank line between them. */
export function renderBlocks(blocks: Block[], width: number, cursorVisible = false): string[] {
	const result: string[] = []
	for (const block of blocks) {
		const lines = renderBlock(block, width)
		if (lines.length === 0) continue
		if (result.length > 0) result.push('')
		result.push(...lines)
	}
	// Append blinking cursor
	const lastBlock = blocks[blocks.length - 1]
	if (lastBlock && isStreaming(lastBlock) && result.length > 0) {
		const cc = cursorColor(lastBlock)
		const extra = inlineCursor(result[result.length - 1], cc, cursorVisible, width)
		result.splice(result.length - 1, 1, ...extra)
	} else if (result.length > 0) {
		// Idle cursor on its own line after completed content
		const cc = lastBlock ? cursorColor(lastBlock) : colors.cursor.fg
		const c = cursorVisible ? `${cc}█${colors.RESET}` : ' '
		result.push('')
		result.push(` ${c}`)
	}
	return result
}
