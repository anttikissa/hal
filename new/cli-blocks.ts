// Block-based content model for tab output.

const RESET = '\x1b[0m'
const TOOL_MAX_OUTPUT = 5
const BLOCK_PAD = 1

// ── OKLCH color system ──

function oklch(L: number, C: number, H: number): [number, number, number] {
	const hRad = H * Math.PI / 180
	const a = C * Math.cos(hRad), b = C * Math.sin(hRad)
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b
	const s_ = L - 0.0894841775 * a - 1.2914855480 * b
	const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
	const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
	const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
	const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
	const toSrgb = (c: number) => Math.round(255 * Math.max(0, Math.min(1,
		c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)))
	return [toSrgb(rl), toSrgb(gl), toSrgb(bl)]
}

function fg256([r, g, b]: [number, number, number]): string { return `\x1b[38;2;${r};${g};${b}m` }
function bg256([r, g, b]: [number, number, number]): string { return `\x1b[48;2;${r};${g};${b}m` }

const CURSOR_COLOR = fg256(oklch(0.75, 0.15, 70)) // orange
const ASST_FG = fg256(oklch(0.75, 0.15, 70))
const ASST_BG = bg256(oklch(0.25, 0.05, 70))

// Tool colors: matched lightness in OKLCH
// Foreground (bright text): L=0.75, C=0.15
// Background (dark bg):     L=0.25, C=0.05
const TOOL_COLORS: Record<string, { fg: string; bg: string }> = {
	bash:    { fg: fg256(oklch(0.75, 0.15, 320)), bg: bg256(oklch(0.25, 0.05, 320)) },
	read:    { fg: fg256(oklch(0.75, 0.15, 145)), bg: bg256(oklch(0.25, 0.05, 145)) },
	default: { fg: fg256(oklch(0.75, 0.15, 260)), bg: bg256(oklch(0.25, 0.05, 260)) },
}

// Input/prompt block colors: cool grey with slight blue tint
const INPUT_FG = fg256(oklch(0.80, 0.008, 250))
const INPUT_BG = bg256(oklch(0.29, 0.008, 250))

// Thinking block color: dim, no background
const THINK_FG = fg256(oklch(0.55, 0.02, 250))

function toolColors(name: string): { fg: string; bg: string } {
	return TOOL_COLORS[name] ?? TOOL_COLORS.default
}

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
	if (block.status) return [toolLine(label + ': ' + block.text, width, INPUT_FG, INPUT_BG)]
	const header = toolHeader(label, width, INPUT_FG, INPUT_BG)
	const body = wordWrap(block.text, CONTENT_W(width)).map(l => toolLine(l, width, INPUT_FG, INPUT_BG))
	return [...header, ...body]
}

function renderAssistant(block: Extract<Block, { type: 'assistant' }>, width: number): string[] {
	const text = collapseBlankLines(block.text.trimEnd())
	if (!text) return []
	const label = block.model ? `Hal (${block.model})` : 'Hal'
	const header = toolHeader(label, width, ASST_FG, ASST_BG)
	const body = wordWrap(text, CONTENT_W(width)).map(l => toolLine(l, width, ASST_FG, ASST_BG))
	return [...header, ...body]
}

function renderThinking(block: Extract<Block, { type: 'thinking' }>, width: number): string[] {
	const pad = ' '.repeat(BLOCK_PAD)
	const text = collapseBlankLines(block.text.trimEnd())
	if (!text) return [`${THINK_FG}${pad}Thinking...${RESET}`]
	return wordWrap(text, CONTENT_W(width)).map(l => `${THINK_FG}${pad}${l}${RESET}`)
}

function elapsed(startTime: number): string {
	const s = (Date.now() - startTime) / 1000
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

function toolLine(text: string, width: number, fg: string, bg: string): string {
	const padded = ' '.repeat(BLOCK_PAD) + text
	return `${bg}${fg}${padded.padEnd(width)}${RESET}`
}

function headerLine(text: string, width: number, fg: string, bg: string): string {
	return `${bg}${fg}${text.padEnd(width)}${RESET}`
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
	const { fg, bg } = toolColors(block.name)
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
	const c = cursorVisible ? `${CURSOR_COLOR}█${RESET}` : ' '
	if (lastBlock && isStreaming(lastBlock) && result.length > 0) {
		const last = result[result.length - 1]
		if (lastBlock.type === 'assistant') {
			result[result.length - 1] = last.slice(0, -(RESET.length + 1)) + c + RESET
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
