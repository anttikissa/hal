// Block rendering — convert history records to visual blocks, render to
// terminal lines with colored backgrounds and headers.
//
// A single assistant history record can produce multiple blocks:
//   thinking → tool₁ → tool₂ → assistant text
// The split happens in historyToBlocks(). Rendering is in renderBlock().

import { visLen, wordWrap, hardWrap, clipVisual, resolveMarkers, expandTabs } from '../utils/strings.ts'
import { md } from './md.ts'
import { colors } from './colors.ts'
import { ason } from '../utils/ason.ts'
import { STATE_DIR } from '../state.ts'
import { perf } from '../perf.ts'
import type { HistoryEntry } from '../server/sessions.ts'

// ── Block types ──────────────────────────────────────────────────────────────

const blockConfig = {
	tabWidth: 4, // tab display width (also controls HTS tab stops)
	blobBatchSize: 64,
	maxToolOutputLines: 20, // cap tool output at this many tail lines
	maxEditDiffLines: 3, // max before/after lines in edit diffs
}

function sanitizeTerminalText(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (ch) => {
		if (ch === '\n' || ch === '\t') return ch
		if (ch === '\r') return '␍'
		if (ch === '\x1b') return '␛'
		return `␀${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
	})
}

// dimmed: true for blocks inherited from a fork parent (rendered with muted colors)
export type Block =
	| { type: 'user'; text: string; source?: string; status?: string; ts?: number; dimmed?: boolean }
	| { type: 'assistant'; text: string; model?: string; ts?: number; streaming?: boolean; dimmed?: boolean }
	| { type: 'thinking'; text: string; blobId?: string; blobLoaded?: boolean; sessionId?: string; ts?: number; streaming?: boolean; dimmed?: boolean }
	| {
			type: 'tool'
			name: string
			input?: any      // tool call input — title and command derived from this
			output?: string
			blobId?: string
			sessionId?: string
			blobLoaded?: boolean
			toolId?: string
			ts?: number
			dimmed?: boolean
	  }
	| { type: 'info'; text: string; ts?: number; dimmed?: boolean }
	| { type: 'warning'; text: string; ts?: number; dimmed?: boolean }
	| { type: 'error'; text: string; ts?: number; dimmed?: boolean }

type NoticeBlock = { type: 'info' | 'warning' | 'error'; text: string; ts?: number }

// ── History → Blocks ─────────────────────────────────────────────────────────
//
// Walk history records in order. Each record becomes one or more blocks.
// tool_result records are skipped — their data is in the blob, which we
// already loaded from the preceding assistant record's tools[].

function parseTs(ts?: string): number | undefined {
	return ts ? Date.parse(ts) : undefined
}

function blobPath(sessionId: string, blobId: string): string {
	return `${STATE_DIR}/sessions/${sessionId}/blobs/${blobId}.ason`
}

// Extract display text from a user entry. User history stores flat parts rather
// than provider-shaped content blocks, but the visual rendering rule is simple:
// text parts show as-is and images show as [image].
function userText(entry: Extract<HistoryEntry, { type: 'user' }>): string {
	const parts: string[] = []
	for (const part of entry.parts) {
		if (part.type === 'text') parts.push(part.text)
		else parts.push(part.originalFile ? `[${part.originalFile}]` : '[image]')
	}
	return parts.join('')
}

function historyToBlocks(history: HistoryEntry[], sessionId: string, parentEntryCount = 0, parentId?: string): Block[] {
	const result: Block[] = []

	for (let i = 0; i < history.length; i++) {
		const entry = history[i]!
		const dimmed = i < parentEntryCount ? true : undefined
		// Blobs for parent entries live in the parent session's directory
		const blobOwner = (i < parentEntryCount && parentId) ? parentId : sessionId
		// ── User message ──
		if (entry.type === 'user') {
			const text = userText(entry)
			if (!text) continue
			const isSystem = text.startsWith('[system] ')
			const source = isSystem ? 'system' : (entry.source ?? undefined)
			result.push({
				type: 'user',
				text: isSystem ? text.slice(9) : text,
				source,
				status: entry.status,
				ts: parseTs(entry.ts),
				dimmed,
			})
			continue
		}

		if (entry.type === 'thinking') {
			result.push({
				type: 'thinking',
				text: entry.text ?? '',
				blobId: entry.blobId,
				sessionId: blobOwner,
				ts: parseTs(entry.ts),
				dimmed,
			})
			continue
		}

		if (entry.type === 'tool_call') {
			result.push({
				type: 'tool',
				name: entry.name,
				input: entry.input,
				blobId: entry.blobId,
				sessionId: blobOwner,
				toolId: entry.toolId,
				ts: parseTs(entry.ts),
				dimmed,
			})
			continue
		}

		if (entry.type === 'assistant') {
			result.push({
				type: 'assistant',
				text: entry.text,
				model: entry.model,
				ts: parseTs(entry.ts),
				dimmed,
			})
			continue
		}

		if (entry.type === 'tool_result') continue

		if (entry.type === 'info') {
			const blockType = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info'
			result.push({ type: blockType, text: entry.text, ts: parseTs(entry.ts), dimmed })
			continue
		}

		// session, forked_from, reset, compact, input_history — not rendered
	}

	return result
}

// ── Background blob loading ──────────────────────────────────────────────────
// Tool and thinking blocks are created without blob data for fast startup.
// After first paint, loadBlobs() fills in the details using parallel async
// reads that yield to the event loop.

function applyToolBlob(block: Extract<Block, { type: 'tool' }>, text: string): void {
	block.blobLoaded = true
	try {
		const blob = ason.parse(text) as any
		block.input = blob?.call?.input
		if (typeof blob?.result?.content === 'string') block.output = blob.result.content
	} catch {}
}

function applyThinkingBlob(block: Extract<Block, { type: 'thinking' }>, text: string): void {
	block.blobLoaded = true
	try {
		const blob = ason.parse(text) as any
		if (typeof blob?.thinking === 'string') block.text = blob.thinking
	} catch {}
}

// Skip blobs larger than this — they're anomalous (e.g. unfiltered grep)
// and would block the event loop during parsing.
const MAX_BLOB_SIZE = 1024 * 1024 // 1 MB

type BlobBlock = Extract<Block, { type: 'tool' }> | Extract<Block, { type: 'thinking' }>

// Load blobs for tool and thinking blocks in parallel batches.
// Returns the number of blobs loaded.
async function loadBlobs(blocks: Block[]): Promise<number> {
	const pending = blocks.filter(
		(b): b is BlobBlock =>
			(b.type === 'tool' || b.type === 'thinking') && !b.blobLoaded && !!b.blobId,
	)
	if (pending.length === 0) return 0

	const batchSize = blockConfig.blobBatchSize
	for (let i = 0; i < pending.length; i += batchSize) {
		const batch = pending.slice(i, i + batchSize)
		// Check file sizes first, skip blobs over 1MB
		const files = batch.map((b) => Bun.file(blobPath(b.sessionId ?? '', b.blobId!)))
		const sizes = await Promise.allSettled(files.map((f) => f.size))

		// Only read files under the size limit
		const reads = files.map((f, j) => {
			const sz = sizes[j]!
			if (sz.status === 'fulfilled' && sz.value <= MAX_BLOB_SIZE) return f.text()
			return Promise.resolve(null)
		})
		const results = await Promise.allSettled(reads)

		for (let j = 0; j < batch.length; j++) {
			const r = results[j]!
			const block = batch[j]!
			if (r.status === 'fulfilled' && r.value !== null) {
				if (block.type === 'tool') applyToolBlob(block, r.value)
				else applyThinkingBlob(block, r.value)
			} else {
				block.blobLoaded = true // mark skipped/failed so we don't retry
			}
		}
		await Bun.sleep(0) // yield to macro-task queue between batches
	}
	return pending.length
}

// ── Tool title & command extraction ──────────────────────────────────────────
//
// Title goes in the header line. Short commands are inlined.
// Long or multiline commands go to the "command" field and render as
// content lines with ' \' continuation for copy-pasteability.

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1)
}

function toolTitle(name: string, input?: any): string {
	if (!input) return capitalize(name)
	switch (name) {
		case 'bash': {
			const cmd = input.command ?? ''
			// Short single-line commands go in the title
			if (!cmd.includes('\n') && cmd.length <= 60) return `Bash: ${cmd}`
			return 'Bash'
		}
		case 'read': {
			let s = `Read ${input.path ?? '?'}`
			if (input.start || input.end) {
				s += ` (${input.start ?? 1}-${input.end ?? 'end'})`
			}
			return s
		}
		case 'read_url':
			return `Read URL ${input.url ?? '?'}`
		case 'write':
			return `Write ${input.path ?? '?'}`
		case 'edit':
			return `Edit ${input.path ?? '?'}`
		case 'eval':
			return 'Eval'
		case 'grep':
			return `Grep ${input.pattern ?? '?'} in ${input.path ?? '?'}`
		case 'glob':
			return `Glob ${input.pattern ?? '?'} in ${input.path ?? '.'}`
		case 'google':
			return `Google ${input.query ?? '?'}`
		case 'analyze_history':
			return `Analyze history${input.sessionId ? ` ${input.sessionId}` : ''}`
		case 'ls':
			return `Ls ${input.path ?? '.'}`
		default:
			return capitalize(name)
	}
}

// Returns the command/code to show as content lines (bash commands, eval code).
// null if the command was already inlined in the title.
function toolCommand(name: string, input?: any): string | undefined {
	if (!input) return undefined
	if (name === 'bash') {
		const cmd = input.command ?? ''
		// If it was short enough for the title, don't repeat
		if (!cmd.includes('\n') && cmd.length <= 60) return undefined
		return cmd
	}
	if (name === 'eval') {
		return input.code ?? undefined
	}
	return undefined
}

// ── Tool output formatting ────────────────────────────────────────────────────
//
// Per-tool formatters that turn raw tool output into concise display lines.
// Edit output gets diff-style coloring. Read shows line/size counts.
// Grep/glob/ls show match counts. Everything else shows truncated tail.

const RED_FG = '\x1b[31m'
const GREEN_FG = '\x1b[32m'
const FG_OFF = '\x1b[39m'

interface ToolFormatResult {
	bodyLines: string[]
	// If set, replaces the "[+ N lines]" indicator
	hiddenIndicator?: string
	// If true, don't show raw output tail — bodyLines replace it
	suppressOutput?: boolean
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function countLines(output: string): number {
	return output.trim() ? output.trimEnd().split('\n').length : 0
}

// For grep/glob/ls: show count of results
function countIndicator(output: string, empty: string, unit: string): ToolFormatResult {
	if (!output.trim() || output === empty) return { bodyLines: [] }
	const total = countLines(output)
	return {
		bodyLines: [],
		hiddenIndicator: total > 5 ? `[${total} ${unit}]` : undefined,
	}
}

// Edit: show diff between before/after with +/- coloring
function formatEdit(output: string): ToolFormatResult {
	if (!output) return { bodyLines: [] }
	const beforeMatch = output.match(/^--- before\n([\s\S]*?)(?:\n\n\+\+\+ after|$)/)
	const afterMatch = output.match(/\+\+\+ after\n([\s\S]*)$/)
	if (!beforeMatch && !afterMatch) return { bodyLines: [] }

	let beforeLines = beforeMatch ? beforeMatch[1]!.split('\n').filter((l) => l.trim()) : []
	let afterLines = afterMatch ? afterMatch[1]!.split('\n').filter((l) => l.trim()) : []

	// Strip common prefix/suffix so only changed lines are shown
	while (beforeLines.length && afterLines.length && beforeLines[0] === afterLines[0]) {
		beforeLines.shift()
		afterLines.shift()
	}
	while (
		beforeLines.length &&
		afterLines.length &&
		beforeLines[beforeLines.length - 1] === afterLines[afterLines.length - 1]
	) {
		beforeLines.pop()
		afterLines.pop()
	}

	const lines: string[] = []
	const MAX = blockConfig.maxEditDiffLines
	for (const [content, prefix, color] of [
		[beforeLines, '\u2212', RED_FG],
		[afterLines, '+', GREEN_FG],
	] as const) {
		if (!content.length) continue
		// Show all lines when hiding just 1 would waste a line on the indicator
		const limit = content.length <= MAX + 1 ? content.length : MAX
		for (const l of content.slice(0, limit)) {
			lines.push(`${color}${prefix} ${l}${FG_OFF}`)
		}
		if (content.length > limit) {
			lines.push(`  \u2026 ${content.length - limit} more`)
		}
	}
	return { bodyLines: lines, suppressOutput: true }
}

function formatRead(output: string): ToolFormatResult {
	if (!output.trim()) return { bodyLines: [] }
	const n = countLines(output)
	const sz = formatSize(Buffer.byteLength(output, 'utf8'))
	return { bodyLines: [`${n} lines, ${sz}`] }
}

function formatWrite(output: string): ToolFormatResult {
	const lines = output.split('\n').filter((l) => l.trim())
	if (!lines.length || (lines.length === 1 && lines[0] === 'ok')) {
		return { bodyLines: [], suppressOutput: true }
	}
	return { bodyLines: lines, suppressOutput: true }
}

// Dispatch table: tool name → formatter
const toolFormatters: Record<string, (output: string) => ToolFormatResult> = {
	edit: formatEdit,
	write: formatWrite,
	grep: (o) => countIndicator(o, 'No matches found.', 'matches'),
	glob: (o) => countIndicator(o, 'No files found.', 'files'),
	ls: (o) => countIndicator(o, '(empty directory)', 'entries'),
	read: formatRead,
}

function formatToolOutput(name: string, output: string): ToolFormatResult {
	return toolFormatters[name]?.(output) ?? { bodyLines: [] }
}

// ── Spinner for in-progress tool calls ───────────────────────────────────────

const SPINNER_CHARS = '\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F'

function spinnerChar(elapsed: number): string {
	// Rotate every 80ms
	const idx = Math.floor(elapsed / 80) % SPINNER_CHARS.length
	return SPINNER_CHARS[idx]!
}

// Format elapsed time: "1.2s" or "1m23s"
function formatElapsed(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	const m = Math.floor(ms / 60_000)
	const s = Math.floor((ms % 60_000) / 1000)
	return `${m}m${String(s).padStart(2, '0')}s`
}

// ── Rendering ────────────────────────────────────────────────────────────────

const RESET_BG = '\x1b[49m'
const DIM = '\x1b[2m'
const DIM_OFF = '\x1b[22m'

// Clip a line to terminal width, preserving raw tabs when possible.
// If the line fits, return it as-is (tabs intact for copying).
// If it overflows, expand tabs first (clipVisual needs real widths) then clip.
function clipLine(line: string, cols: number): string {
	if (visLen(expandTabs(line, blockConfig.tabWidth)) <= cols) return line
	return clipVisual(expandTabs(line, blockConfig.tabWidth), cols)
}

// Fill a line's background to full terminal width.
// Paints bg + \x1b[K (erase to EOL with current bg) first, then \r back
// and writes content on top. Tab characters skip over cells without
// overwriting, so the bg color shows through tab gaps. No trailing spaces
// in the copy buffer (unlike space-padding).
function bgLine(content: string, cols: number, bg: string): string {
	return `${bg}\x1b[K\r${content}${RESET_BG}`
}

// Get the fg/bg colors for a block
function blockColors(block: Block): { fg: string; bg: string } {
	switch (block.type) {
		case 'assistant':
			return colors.assistant
		case 'thinking':
			return colors.thinking
		case 'user':
			return colors.user
		case 'tool':
			return colors.tool(block.name)
		case 'info':
			return colors.info
		case 'warning':
			return colors.warning
		case 'error':
			return colors.error
	}
}

function formatHHMM(ts?: number): string {
	if (!ts) return ''
	const d = new Date(ts)
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Build the header line:  ── HH:MM Title ──────────── (session/blob) ──
function buildHeader(title: string, time: string, blobRef: string, cols: number): string {
	const left = time ? `── ${time} ${title} ` : `── ${title} `
	const right = blobRef ? ` ${DIM}(${blobRef})${DIM_OFF} ──` : ''
	// Fill between left and right with ─
	const fillLen = Math.max(1, cols - visLen(left) - visLen(right))
	return `${left}${'─'.repeat(fillLen)}${right}`
}

// Block label for the header
function blockLabel(block: Block): string {
	switch (block.type) {
		case 'user': {
			if (block.source && block.source !== 'user' && block.source !== 'system') {
				return `Inbox · ${block.source}`
			}
			if (block.status === 'steering') return 'You (steering)'
			if (block.status === 'queued') return 'You (queued)'
			return 'You'
		}
		case 'assistant':
			return 'Hal'
		case 'thinking':
			return 'Thinking'
		case 'tool':
			return toolTitle(block.name, block.input)
		case 'info':
			return 'Info'
		case 'warning':
			return 'Warning'
		case 'error':
			return 'Error'
	}
}

// Format bash command for display: append ' \' to all but last line
// so multiline commands can be copy-pasted into a shell.
function formatBashCommand(cmd: string, contentWidth: number): string[] {
	const rawLines = cmd.split('\n')
	if (rawLines.length === 1 && visLen(cmd) <= contentWidth) {
		return [cmd]
	}
	// Wrap each raw line, then join with ' \'
	const result: string[] = []
	for (let i = 0; i < rawLines.length; i++) {
		// Reserve 2 chars for ' \' continuation on all but last line
		const isLast = i === rawLines.length - 1
		const wrapWidth = isLast ? contentWidth : contentWidth - 2
		const wrapped = wordWrap(rawLines[i]!, wrapWidth)
		for (let j = 0; j < wrapped.length; j++) {
			const lineIsLast = isLast && j === wrapped.length - 1
			result.push(lineIsLast ? wrapped[j]! : wrapped[j]! + ' \\')
		}
	}
	return result
}

// Render block content lines (without background — caller adds it).
function blockContent(block: Block, cols: number): string[] {
	const cw = cols
	const indent = ''

	if (block.type === 'assistant' || block.type === 'thinking') {
		// Markdown-rendered text (assistant and thinking share the same path)
		const lines: string[] = []
		for (const span of md.mdSpans(sanitizeTerminalText(block.text))) {
			if (span.type === 'code') {
				for (const raw of span.lines) {
					// Expand tabs for width measurement and wrapping (charWidth
					// returns 0 for \t). Hard-wrap at column boundary since
					// word-wrap would mangle code.
					const expanded = expandTabs(raw, blockConfig.tabWidth)
					for (const wl of hardWrap(expanded, cols)) {
						lines.push(`${indent}${DIM}${wl}${DIM_OFF}`)
					}
				}
			} else if (span.type === 'table') {
				for (const l of md.mdTable(span.lines, cw)) lines.push(`${indent}${l}`)
			} else {
				for (const l of span.lines) {
					for (const wl of wordWrap(`${indent}${md.mdInline(l)}`, cols)) lines.push(wl)
				}
			}
		}
		// Strip leading blank lines (models often start with \n\n)
		while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
		// Strip trailing blank lines (models often end with \n\n)
		while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
		return resolveMarkers(lines)
	}

	if (block.type === 'tool') {
		const lines: string[] = []
		// Command lines (bash, eval) — keep real tabs for copyability.
		// expandTabs only for formatBashCommand width calculation.
		const command = toolCommand(block.name, block.input)
		if (command) {
			for (const l of formatBashCommand(command, cw)) {
				lines.push(`${indent}${l}`)
			}
		}
		// Per-tool formatted output — keep real tabs.
		// expandTabs only where we need to measure/clip.
		if (block.output) {
			const output = sanitizeTerminalText(block.output)
			const fmt = formatToolOutput(block.name, output)

			// Tool-specific body lines (diffs, counts)
			for (const l of fmt.bodyLines) {
				lines.push(`${indent}${clipLine(l, cw)}`)
			}

			// Raw output tail (unless formatter suppressed it)
			if (!fmt.suppressOutput) {
				const outLines = output.trimEnd().split('\n')
				const MAX = blockConfig.maxToolOutputLines
				if (outLines.length > MAX) {
					const indicator = fmt.hiddenIndicator ?? `[+ ${outLines.length - MAX} lines]`
					lines.push(`${indent}${DIM}${indicator}${DIM_OFF}`)
					for (const l of outLines.slice(-MAX)) {
						lines.push(`${indent}${clipLine(l, cw)}`)
					}
				} else {
					for (const l of outLines) {
						lines.push(`${indent}${clipLine(l, cw)}`)
					}
				}
			}
		}
		return lines
	}

	// User, info, error — plain text with word wrap.
	// Expand tabs here (word wrap needs real character widths).
	const text = sanitizeTerminalText(block.text)
	const lines: string[] = []
	for (const raw of expandTabs(text, blockConfig.tabWidth).split('\n')) {
		for (const wl of wordWrap(`${indent}${raw}`, cols)) lines.push(wl)
	}
	return lines
}


function wrapBricks(bricks: string[], cols: number): string[] {
	const lines: string[] = []
	let current = ''
	for (const brick of bricks) {
		if (!current) {
			if (visLen(brick) <= cols) {
				current = brick
				continue
			}
			const wrapped = wordWrap(brick, cols)
			lines.push(...wrapped.slice(0, -1))
			current = wrapped[wrapped.length - 1] ?? ''
			continue
		}
		const joined = `${current} ${brick}`
		if (visLen(joined) <= cols) {
			current = joined
			continue
		}
		lines.push(current)
		if (visLen(brick) <= cols) {
			current = brick
			continue
		}
		const wrapped = wordWrap(brick, cols)
		lines.push(...wrapped.slice(0, -1))
		current = wrapped[wrapped.length - 1] ?? ''
	}
	if (current) lines.push(current)
	return lines
}

function renderBlockGroup(group: NoticeBlock[], cols: number): string[] {
	if (group.length === 0) return []
	if (group.length === 1) return renderBlock(group[0] as Block, cols)
	const first = group[0]!
	const { fg, bg } = blockColors(first as Block)
	const header = buildHeader(blockLabel(first as Block), formatHHMM(first.ts), '', cols)
	const bricks = group.flatMap((block) => expandTabs(block.text, blockConfig.tabWidth).split('\n').map((line) => `[${line}]`))
	const lines = [bgLine(`${fg}${header}`, cols, bg)]
	for (const line of wrapBricks(bricks, cols)) lines.push(bgLine(`${fg}${line}`, cols, bg))
	if (lines.length > 0) lines[lines.length - 1] += '\x1b[39m'
	return lines
}

// ── Main render function ─────────────────────────────────────────────────────

function renderBlock(block: Block, cols: number): string[] {
	// Tool blocks render with whatever data is available.
	// Blob data is filled in by the background loader, not during render.
	const label = blockLabel(block)
	const time = formatHHMM(block.ts)
	const { fg, bg } = blockColors(block)

	// Blob ref: "(sessionId/blobId)"
	let blobRef = ''
	if ('blobId' in block && block.blobId && 'sessionId' in block && block.sessionId) {
		blobRef = `${block.sessionId}/${block.blobId}`
	}

	const header = buildHeader(label, time, blobRef, cols)
	const content = blockContent(block, cols)

	const lines: string[] = []
	// Foreground color applied to header and content; bg fills full width
	lines.push(bgLine(`${fg}${header}`, cols, bg))
	for (const l of content) lines.push(bgLine(`${fg}${l}`, cols, bg))
	// Reset fg after block so it doesn't leak into subsequent lines
	if (lines.length > 0) lines[lines.length - 1] += '\x1b[39m'
	return lines
}

// ── Namespace ────────────────────────────────────────────────────────────────

export const blocks = {
	config: blockConfig,
	historyToBlocks,
	renderBlock,
	renderBlockGroup,
	loadBlobs,
	formatToolOutput,
	spinnerChar,
	formatElapsed,
}
