// Block rendering — convert history records to visual blocks, render to
// terminal lines with colored backgrounds and headers.
//
// A single assistant history record can produce multiple blocks:
//   thinking → tool₁ → tool₂ → assistant text
// The split happens in historyToBlocks(). Rendering is in renderBlock().

import { visLen, wordWrap, clipVisual, resolveMarkers, expandTabs } from '../utils/strings.ts'
import { md } from './md.ts'
import { colors } from './colors.ts'
import { ason } from '../utils/ason.ts'
import { STATE_DIR } from '../state.ts'
import { perf } from '../perf.ts'
import type { HistoryEntry } from '../server/sessions.ts'

// ── Block types ──────────────────────────────────────────────────────────────

const blockConfig = {
	blobBatchSize: 64,
	maxToolOutputLines: 20,      // cap tool output at this many tail lines
	maxEditDiffLines: 3,         // max before/after lines in edit diffs
}

export type Block =
	| { type: 'user'; text: string; source?: string; status?: string; ts?: number }
	| { type: 'assistant'; text: string; model?: string; ts?: number }
	| { type: 'thinking'; text: string; blobId?: string; sessionId?: string; ts?: number }
	| { type: 'tool'; name: string; title: string; command?: string; output?: string; blobId?: string; sessionId?: string; blobLoaded?: boolean; toolId?: string; ts?: number }
	| { type: 'info'; text: string; ts?: number }
	| { type: 'error'; text: string; ts?: number }

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

// Extract display text from a user entry. Handles plain string content
// and multimodal arrays (text + image blocks).
function userText(entry: HistoryEntry): string {
	const content = entry.content ?? entry.text
	if (typeof content === 'string') return content
	if (Array.isArray(content)) {
		const parts: string[] = []
		for (const part of content as any[]) {
			if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
			else if (part?.type === 'image') parts.push('[image]')
		}
		return parts.join('') || ''
	}
	return ''
}

function historyToBlocks(history: HistoryEntry[], sessionId: string): Block[] {
	const result: Block[] = []

	for (const entry of history) {
		// ── User message ──
		if (entry.role === 'user') {
			const text = userText(entry)
			if (!text) continue
			// [system] prefix → source = 'system'
			const isSystem = text.startsWith('[system] ')
			const source = isSystem ? 'system' : (entry.source ?? undefined)
			result.push({
				type: 'user',
				text: isSystem ? text.slice(9) : text,
				source,
				status: entry.status,
				ts: parseTs(entry.ts),
			})
			continue
		}

		// ── Assistant turn: split into thinking + tools + text ──
		if (entry.role === 'assistant') {
			// Thinking block
			if (entry.thinkingText) {
				result.push({
					type: 'thinking',
					text: entry.thinkingText,
					blobId: entry.thinkingBlobId,
					sessionId,
					ts: parseTs(entry.ts),
				})
			}

			// Tool blocks — created without blob data for fast startup.
			// Blob content (title details, command, output) loads lazily
			// on first render via ensureToolBlobLoaded().
			if (entry.tools && Array.isArray(entry.tools)) {
				for (const tool of entry.tools as any[]) {
					result.push({
						type: 'tool',
						name: tool.name,
						title: capitalize(tool.name),
						blobId: tool.blobId,
						sessionId,
						ts: parseTs(entry.ts),
					})
				}
			}

			// Assistant text block
			if (typeof entry.text === 'string' && entry.text) {
				result.push({
					type: 'assistant',
					text: entry.text,
					model: entry.model,
					ts: parseTs(entry.ts),
				})
			}
			continue
		}

		// ── tool_result — skip, data already loaded from blob above ──
		if (entry.role === 'tool_result') continue

		// ── Info / error ──
		if (entry.type === 'info') {
			const isError = entry.level === 'error'
			if (typeof entry.text === 'string') {
				result.push({ type: isError ? 'error' : 'info', text: entry.text, ts: parseTs(entry.ts) })
			}
			continue
		}

		// session, forked_from, etc. — not rendered
	}

	return result
}

// ── Background blob loading ──────────────────────────────────────────────────
// Tool blocks are created without blob data for fast startup. After first
// paint, loadToolBlobs() fills in title details, command, and output
// using parallel async reads that yield to the event loop.

function applyBlob(block: Extract<Block, { type: 'tool' }>, text: string): void {
	block.blobLoaded = true
	try {
		const blob = ason.parse(text) as any
		const input = blob?.call?.input
		block.title = toolTitle(block.name, input)
		block.command = toolCommand(block.name, input)
		if (typeof blob?.result?.content === 'string') block.output = blob.result.content
	} catch {}
}

// Load blobs for a list of tool blocks in parallel batches.
// Returns the number of blobs loaded.
// Skip blobs larger than this — they're anomalous (e.g. unfiltered grep)
// and would block the event loop during parsing.
const MAX_BLOB_SIZE = 1024 * 1024 // 1 MB

async function loadToolBlobs(blocks: Block[]): Promise<number> {
	const tools = blocks.filter(
		(b): b is Extract<Block, { type: 'tool' }> => b.type === 'tool' && !b.blobLoaded && !!b.blobId,
	)
	if (tools.length === 0) return 0

	const batchSize = blockConfig.blobBatchSize
	for (let i = 0; i < tools.length; i += batchSize) {
		const batch = tools.slice(i, i + batchSize)
		// Check file sizes first, skip blobs over 1MB
		const files = batch.map(b => Bun.file(blobPath(b.sessionId ?? '', b.blobId!)))
		const sizes = await Promise.allSettled(files.map(f => f.size))

		// Only read files under the size limit
		const reads = files.map((f, j) => {
			const sz = sizes[j]!
			if (sz.status === 'fulfilled' && sz.value <= MAX_BLOB_SIZE) return f.text()
			return Promise.resolve(null)
		})
		const results = await Promise.allSettled(reads)

		for (let j = 0; j < batch.length; j++) {
			const r = results[j]!
			if (r.status === 'fulfilled' && r.value !== null) applyBlob(batch[j]!, r.value)
			else batch[j]!.blobLoaded = true // mark skipped/failed so we don't retry
		}
		await Bun.sleep(0) // yield to macro-task queue between batches
	}
	return tools.length
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
			if (input.offset) s += `:${input.offset}`
			if (input.limit) s += `-${input.offset + input.limit}`
			return s
		}
		case 'write': return `Write ${input.path ?? '?'}`
		case 'edit': return `Edit ${input.path ?? '?'}`
		case 'eval': return 'Eval'
		case 'grep': return `Grep ${input.pattern ?? '?'} in ${input.path ?? '?'}`
		case 'ls': return `Ls ${input.path ?? '.'}`
		default: return capitalize(name)
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

	let beforeLines = beforeMatch ? beforeMatch[1]!.split('\n').filter(l => l.trim()) : []
	let afterLines = afterMatch ? afterMatch[1]!.split('\n').filter(l => l.trim()) : []

	// Strip common prefix/suffix so only changed lines are shown
	while (beforeLines.length && afterLines.length && beforeLines[0] === afterLines[0]) {
		beforeLines.shift(); afterLines.shift()
	}
	while (beforeLines.length && afterLines.length &&
		beforeLines[beforeLines.length - 1] === afterLines[afterLines.length - 1]) {
		beforeLines.pop(); afterLines.pop()
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
	const lines = output.split('\n').filter(l => l.trim())
	if (!lines.length || (lines.length === 1 && lines[0] === 'ok')) {
		return { bodyLines: [], suppressOutput: true }
	}
	return { bodyLines: lines, suppressOutput: true }
}

// Dispatch table: tool name → formatter
const toolFormatters: Record<string, (output: string) => ToolFormatResult> = {
	edit: formatEdit,
	write: formatWrite,
	grep: o => countIndicator(o, 'No matches found.', 'matches'),
	glob: o => countIndicator(o, 'No files found.', 'files'),
	ls: o => countIndicator(o, '(empty directory)', 'entries'),
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

// Pad content to full terminal width with a given background color.
// Uses \x1b[49m (default bg) at EOL, not \x1b[0m (full reset),
// so this is safe even when resolveMarkers has active styles.
function bgLine(content: string, cols: number, bg: string): string {
	const pad = Math.max(0, cols - visLen(content))
	return `${bg}${content}${' '.repeat(pad)}${RESET_BG}`
}

// Get the fg/bg colors for a block
function blockColors(block: Block): { fg: string; bg: string } {
	switch (block.type) {
		case 'assistant': return colors.assistant
		case 'thinking': return colors.thinking
		case 'user': return colors.user
		case 'tool': return colors.tool(block.name)
		case 'info': return colors.info
		case 'error': return colors.error
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
				return `Message from ${block.source}`
			}
			if (block.status === 'steering') return 'You (steering)'
			if (block.status === 'queued') return 'You (queued)'
			return 'You'
		}
		case 'assistant': return 'Hal'
		case 'thinking': return 'Thinking'
		case 'tool': return block.title
		case 'info': return 'Info'
		case 'error': return 'Error'
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
	// 1 char left margin
	const cw = cols - 1
	const indent = ' '

	if (block.type === 'assistant') {
		// Markdown-rendered assistant text
		const lines: string[] = []
		for (const span of md.mdSpans(block.text)) {
			if (span.type === 'code') {
				for (const raw of span.lines) {
					// Expand tabs BEFORE measuring — charWidth returns 0 for
					// tabs, so visLen/clipVisual would undercount and bgLine
					// would overpad, causing the line to wrap on the terminal.
					const l = expandTabs(raw)
					const styled = `${indent}${DIM}${l}${DIM_OFF}`
					lines.push(visLen(styled) > cols ? clipVisual(styled, cols) : styled)
				}
			} else if (span.type === 'table') {
				for (const l of md.mdTable(span.lines, cw)) lines.push(`${indent}${l}`)
			} else {
				for (const l of span.lines) {
					for (const wl of wordWrap(`${indent}${md.mdInline(l)}`, cols)) lines.push(wl)
				}
			}
		}
		return resolveMarkers(lines)
	}

	if (block.type === 'tool') {
		const lines: string[] = []
		// Command lines (bash, eval) — expand tabs in command text
		if (block.command) {
			for (const l of formatBashCommand(expandTabs(block.command), cw)) {
				lines.push(`${indent}${l}`)
			}
		}
		// Per-tool formatted output (diff coloring, counts, etc.)
		if (block.output) {
			// Expand tabs in output before any measuring/clipping.
			// Tool output frequently contains tabs (ls, cat, make, etc.)
			const output = expandTabs(block.output)
			const fmt = formatToolOutput(block.name, output)

			// Tool-specific body lines (diffs, counts)
			for (const l of fmt.bodyLines) {
				lines.push(`${indent}${clipVisual(l, cw)}`)
			}

			// Raw output tail (unless formatter suppressed it)
			if (!fmt.suppressOutput) {
				const outLines = output.trimEnd().split('\n')
				const MAX = blockConfig.maxToolOutputLines
				if (outLines.length > MAX) {
					const indicator = fmt.hiddenIndicator ?? `[+ ${outLines.length - MAX} lines]`
					lines.push(`${indent}${DIM}${indicator}${DIM_OFF}`)
					for (const l of outLines.slice(-MAX)) {
						lines.push(`${indent}${clipVisual(l, cw)}`)
					}
				} else {
					for (const l of outLines) {
						lines.push(`${indent}${clipVisual(l, cw)}`)
					}
				}
			}
		}
		return lines
	}

	// User, thinking, info, error — plain text with word wrap.
	// Expand tabs here too (users can paste tabbed content).
	const text = block.type === 'user' ? block.text
		: block.type === 'thinking' ? block.text
		: block.text
	const lines: string[] = []
	for (const raw of expandTabs(text).split('\n')) {
		for (const wl of wordWrap(`${indent}${raw}`, cols)) lines.push(wl)
	}
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
	historyToBlocks, renderBlock, loadToolBlobs,
	formatToolOutput, spinnerChar, formatElapsed,
}
