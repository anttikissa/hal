// Block-based content model for tab output.

import * as colors from './colors.ts'

const TOOL_MAX_OUTPUT = 5
const BLOCK_PAD = 1
export type Block =
	| { type: 'input'; text: string; model?: string; source?: string; status?: 'queued' | 'steering' }
	| { type: 'assistant'; text: string; done: boolean; model?: string }
	| { type: 'thinking'; text: string; done: boolean }
	| { type: 'tool'; name: string; status: 'streaming' | 'running' | 'done' | 'error';
		args: string; output: string; startTime: number }

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

function wordWrap(text: string, width: number): string[] {
	const lines: string[] = []
	for (const raw of text.split('\n')) {
		if (raw.length <= width || width <= 0) {
			lines.push(raw)
		} else {
			let remaining = raw
			while (remaining.length > width) {
				let breakAt = remaining.lastIndexOf(' ', width)
				if (breakAt <= 0) breakAt = width
				lines.push(remaining.slice(0, breakAt))
				remaining = remaining[breakAt] === ' ' ? remaining.slice(breakAt + 1) : remaining.slice(breakAt)
			}
			lines.push(remaining)
		}
	}
	return lines
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
	const header = toolHeader(label, width, colors.assistant.fg, colors.assistant.bg)
	const body = wordWrap(text, CONTENT_W(width)).map(l => toolLine(l, width, colors.assistant.fg, colors.assistant.bg))
	return [...header, ...body]
}

function renderThinking(block: Extract<Block, { type: 'thinking' }>, width: number): string[] {
	const pad = ' '.repeat(BLOCK_PAD)
	const text = collapseBlankLines(block.text.trimEnd())
	if (!text) return [`${colors.thinking.fg}${pad}Thinking...${colors.RESET}`]
	return wordWrap(text, CONTENT_W(width)).map(l => `${colors.thinking.fg}${pad}${l}${colors.RESET}`)
}

function elapsed(startTime: number): string {
	const s = (Date.now() - startTime) / 1000
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

function toolLine(text: string, width: number, fg: string, bg: string): string {
	const padded = ' '.repeat(BLOCK_PAD) + expandTabs(text)
	return `${bg}${fg}${padded.padEnd(width)}${colors.RESET}`
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
	const time = elapsed(block.startTime)
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
		case 'tool': return renderTool(block, width)
	}
}

function isStreaming(block: Block): boolean {
	return (block.type === 'assistant' || block.type === 'thinking') && !block.done
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
	const c = cursorVisible ? `${colors.cursor.fg}█${colors.RESET}` : ' '
	if (lastBlock && isStreaming(lastBlock) && result.length > 0) {
		const last = result[result.length - 1]
		if (lastBlock.type === 'assistant') {
			result[result.length - 1] = last.slice(0, -(colors.RESET.length + 1)) + c + colors.RESET
		} else {
			result[result.length - 1] = last + c
		}
	} else if (result.length > 0) {
		// Idle cursor on its own line after completed content
		result.push('')
		result.push(` ${c}`)
	}
	return result
}
