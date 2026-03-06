// Block-based content model for tab output.

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'
const ITALIC = '\x1b[3m'
const TOOL_FG = '\x1b[95m' // bright magenta
const TOOL_BG = '\x1b[48;5;53m' // dark magenta background
const TOOL_MAX_OUTPUT = 5

export type Block =
	| { type: 'input'; text: string; source?: string; status?: 'queued' | 'steering' }
	| { type: 'assistant'; text: string; done: boolean }
	| { type: 'thinking'; text: string; done: boolean }
	| { type: 'tool'; name: string; status: 'streaming' | 'running' | 'done' | 'error';
		args: string; output: string; startTime: number }

/** Collapse runs of 3+ newlines to 2 (preserving paragraph breaks). */
function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, '\n\n')
}

function wrapLines(text: string, width: number): string[] {
	const lines: string[] = []
	for (const raw of text.split('\n')) {
		if (raw.length <= width || width <= 0) {
			lines.push(raw)
		} else {
			for (let i = 0; i < raw.length; i += width) {
				lines.push(raw.slice(i, i + width))
			}
		}
	}
	return lines
}

function renderInput(block: Extract<Block, { type: 'input' }>, width: number): string[] {
	const src = block.source && block.source !== 'user' ? `${block.source} ` : ''
	if (block.status === 'queued') {
		return [`${DIM}${src}(queued): ${block.text}${RESET}`]
	}
	if (block.status === 'steering') {
		return [`${DIM}${src}(steering): ${block.text}${RESET}`]
	}
	const prefix = src ? `${DIM}${src}${RESET}` : ''
	return wrapLines(`${prefix}> ${block.text}`, width)
}

function renderAssistant(block: Extract<Block, { type: 'assistant' }>, width: number): string[] {
	const text = collapseBlankLines(block.text.trimEnd())
	if (!text) return []
	return wrapLines(text, width)
}

function renderThinking(block: Extract<Block, { type: 'thinking' }>, width: number): string[] {
	if (block.done) {
		return [`${DIM}${ITALIC}Thinking...${RESET}`]
	}
	const text = collapseBlankLines(block.text.trimEnd())
	if (!text) return [`${DIM}${ITALIC}Thinking...${RESET}`]
	return wrapLines(text, width).map(l => `${DIM}${ITALIC}${l}${RESET}`)
}

function elapsed(startTime: number): string {
	const s = (Date.now() - startTime) / 1000
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

function toolLine(text: string, width: number): string {
	return `${TOOL_BG}${TOOL_FG}${text.padEnd(width)}${RESET}`
}

function toolHeader(label: string, width: number): string[] {
	const prefix = '── '
	const inner = prefix + label + ' '
	if (inner.length >= width) {
		// Wraps: hard-wrap the full text, put ─ fill on last line
		const full = prefix + label + ' '
		const lines: string[] = []
		for (let i = 0; i < full.length; i += width) {
			lines.push(full.slice(i, i + width))
		}
		// Fill remainder of last line with ─
		const last = lines[lines.length - 1]
		lines[lines.length - 1] = last + '─'.repeat(Math.max(0, width - last.length))
		return lines.map(l => toolLine(l, width))
	}
	const fill = '─'.repeat(Math.max(0, width - inner.length))
	return [toolLine(inner + fill, width)]
}

function renderTool(block: Extract<Block, { type: 'tool' }>, width: number): string[] {
	const time = elapsed(block.startTime)
	const statusSuffix = block.status === 'error' ? ' ✗' : block.status === 'done' ? ' ✓' : ''
	const label = `${block.name}: ${block.args} (${time})${statusSuffix}`
	const header = toolHeader(label, width)

	const outputText = block.output.trimEnd()
	if (!outputText) return header

	const outputLines = outputText.split('\n')
	const lines = [...header]

	if (outputLines.length > TOOL_MAX_OUTPUT) {
		const hidden = outputLines.length - TOOL_MAX_OUTPUT
		lines.push(toolLine(`[+ ${hidden} lines]`, width))
		for (const l of outputLines.slice(-TOOL_MAX_OUTPUT)) {
			lines.push(toolLine(l, width))
		}
	} else {
		for (const l of outputLines) {
			lines.push(toolLine(l, width))
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

/** Render all blocks with one blank line between them. */
export function renderBlocks(blocks: Block[], width: number): string[] {
	const result: string[] = []
	for (const block of blocks) {
		const lines = renderBlock(block, width)
		if (lines.length === 0) continue
		if (result.length > 0) result.push('')
		result.push(...lines)
	}
	return result
}
