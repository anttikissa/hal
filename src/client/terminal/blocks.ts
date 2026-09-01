// Block rendering — paint Block objects (see block-data.ts) as terminal
// lines with colored backgrounds, headers, markdown bodies and streaming
// cursors. Text sanitization/hyperlinking lives in block-text.ts and
// per-tool display logic in tool-specs.ts.

import { clipVisual, expandTabs, hardWrap, M_BOLD, M_BOLD_OFF, M_ITALIC, M_ITALIC_OFF, resolveMarkers, visLen, wordWrap } from '../../utils/strings.ts'
import { models } from '../../common/models.ts'
import { historyProjection } from '../../common/history-projection.ts'
import { transcriptTitles } from '../../common/transcript-titles.ts'
import { subscriptionUsage } from '../../common/subscription-usage.ts'
import { time } from '../../utils/time.ts'
import { terminalSubscriptionUsage } from './subscription-usage.ts'
import { colors } from './colors.ts'
import { md, type MdColors } from './md.ts'
import { blockText } from './block-text.ts'
import { toolSpecs } from './tool-specs.ts'
// Sizing/limits live in ../block-config.ts so block-data.ts and tool-specs.ts
// can read them without importing this renderer. Local alias keeps the many
// `blockConfig.x` call sites unchanged; it is the same mutable object, so
// config reloads and eval patches still apply.
import { blockConfig as clientBlockConfig } from '../block-config.ts'
import { terminalQuestions } from './questions.ts'

const blockConfig = clientBlockConfig.config

// Block type lives in block-data.ts; re-exported so renderers can keep
// importing it from blocks.ts.
export type { Block } from '../block-data.ts'
import type { Block } from '../block-data.ts'

export type SessionLabel = (sessionId: string) => string

function markdownSourceText(block: Exclude<Block, { type: 'tool' | 'user' | 'fork' | 'question' }>): string {
	if (block.usageBars) {
		// Sanitize account labels before turning server-authored semantic markers into
		// terminal escape sequences. The server never needs to know about ANSI.
		const text = blockText.sanitizeTerminalText(block.text)
		return subscriptionUsage.replaceUsageBarMarkers(text, terminalSubscriptionUsage.usageBar)
	}
	let text =
		block.type === 'log' || block.type === 'info' || block.type === 'warning' || block.type === 'error'
			? blockText.stripAnsiSequences(block.text)
			: block.text
	if (block.type === 'log' && text.startsWith('Prompt queued')) text = text.slice(text.indexOf('\n') + 1)
	if (block.type === 'log' || block.type === 'info') text = historyProjection.noticeText(text)
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
		link: palette.linkBg ? [`${palette.linkFg ?? palette.code ?? palette.fg}${palette.linkBg}`, `${palette.fg}${palette.bg}`] : undefined,
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
	const finished = !('streaming' in block && block.streaming)
	let source = markdownSourceText(block)
	// Do not paint a partial code-fence delimiter as transcript content: the third
	// backtick would remove that row after it may already be frozen in scrollback.
	if (!finished) source = source.replace(/(^|\n)`{1,2}$/, '$1')
	for (const span of md.mdSpans(source)) {
		if (span.type === 'code') {
			for (const raw of span.lines) pushCodeWrapped(lines, raw, cols, mdColors, isTextCodeLang(span.lang))
		} else if (span.type === 'table') {
			lines.push(...md.mdTable(span.lines, cols, mdColors))
		} else {
			for (const line of span.lines) {
				const standalone = finished && blockText.standaloneHyperlink(line)
				if (standalone) {
					lines.push(standalone)
					continue
				}
				const wrapped = wordWrap(md.mdInline(line, mdColors), cols)
				lines.push(...md.containWrappedAnsiStyle(wrapped, mdColors.link))
			}
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

function wrapToolLine(line: string, cols: number): string[] {
	const hashline = line.match(/^(.*?\d+:[A-Za-z0-9]+ )(.*)$/)
	// Hashline metadata is not part of the source column where indentation starts.
	const expanded = hashline ? `${hashline[1]}${expandTabs(hashline[2]!, blockConfig.tabWidth)}` : expandTabs(line, blockConfig.tabWidth)
	return wordWrap(expanded, cols)
}

function containToolLines(lines: string[], cols: number, overflow: 'head' | 'tail' | undefined, hiddenIndicator?: string): string[] {
	const max = Math.max(0, blockConfig.maxToolTextRows - 1)
	if (lines.length <= max) return lines
	if (max === 0) return []
	const indicator = clipVisual(hiddenIndicator ?? `[+ ${lines.length - max + 1} rows]`, cols)
	if (max === 1) return [indicator]
	if (overflow === 'head') return [...lines.slice(0, max - 1), indicator]
	const head = Math.min(2, max - 1)
	const tail = max - head - 1
	return [...lines.slice(0, head), indicator, ...lines.slice(lines.length - tail)]
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
		if (block.toolSummary) return []
		const lines: string[] = []
		const spec = toolSpecs.getToolSpec(block.name)
		const command = spec.command?.(block.input, block.output)
		if (command) lines.push(...formatToolCommand(command, cols, spec.shellContinuations?.(block.input, block.output) ?? block.name === 'bash'))
		const details = spec.details?.(block.input, block.output)
		if (details) pushWrapped(lines, details, cols)
		let hiddenIndicator: string | undefined
		if (block.output) {
			const output = blockText.sanitizeTerminalText(blockText.stripAnsiSequences(block.output))
			const format = spec.format?.(output, cols, block.input) ?? { bodyLines: [] }
			for (const line of format.bodyLines) lines.push(...wrapToolLine(line, cols))
			hiddenIndicator = format.hiddenIndicator
			if (!format.suppressOutput) {
				for (const line of output.trimEnd().split('\n')) lines.push(...wrapToolLine(line, cols))
			}
		}
		return containToolLines(lines, cols, spec.overflow, hiddenIndicator)
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

const fixedNoticeColors = { warning: colors.warning, error: colors.error, fork: colors.fork }

function blockColors(block: Block): { fg: string; bg: string; bgIsBlack?: boolean; bold?: string; code?: string; linkFg?: string; linkBg?: string } {
	if (block.type === 'assistant') return colors.assistant
	if (block.type === 'thinking') return colors.thinking
	if (block.type === 'user') return colors.user
	if (block.type === 'log' && block.text.startsWith('Prompt queued')) return colors.warning
	if (block.type === 'question') return block.active ? colors.warning : { ...colors.log, bg: '' }
	if (block.type === 'log' && block.usageBars) return colors.log
	if (block.type === 'log' || block.type === 'info') return { ...colors.log, bg: '' }
	if (block.type === 'tool') return colors.tool(block.name)
	return fixedNoticeColors[block.type]
}

function buildHeader(title: string, time: string, blobRef: string, cols: number, activity = ''): string {
	let prefix = `${' '.repeat(blocks.outputPad)}${time ? `${time} ` : ''}`
	if (activity) prefix += `${activity} `
	const right = blobRef ? ` (${blobRef}) ` : ''
	// Stop one column short of the edge so headers keep the same right margin as
	// block bodies. bgLine still paints the background across the full row.
	const width = Math.max(1, cols - 1)
	const titleWidth = Math.max(1, width - visLen(prefix) - visLen(right))
	const left = `${prefix}${clipVisual(title, titleWidth)}`
	return `${left}${' '.repeat(Math.max(0, width - visLen(left) - visLen(right)))}${right}`
}

function toolSpinner(frame: number | undefined): string {
	if (frame === undefined) return ''
	const frames = ['◐', '◓', '◑', '◒']
	return frames[((frame % frames.length) + frames.length) % frames.length]!
}

function toolActivity(block: Block): string {
	if (block.type !== 'tool') return ''
	if (!block.running) return '✓'
	return blocks.toolSpinner(block.toolActivityFrame ?? 0)
}

function padBlockLine(line: string): string {
	return ' '.repeat(blocks.outputPad) + line
}

function bodyLine(line: string, fg: string, bg: string, cols: number, fullWidth = visLen(line) > cols - 1 - blocks.outputPad): string {
	if (!fullWidth) return bgLine(`${fg}${padBlockLine(line)}`, cols, bg)
	return `${bg}${fg}${line}\x1b[K${RESET_BG}`
}

function noticeContent(block: Block, cols: number): string[] {
	const timestamp = time.formatTimestamp(block.ts)
	const prefix = timestamp ? `${timestamp} ` : ''
	const content = blockContent(block, Math.max(1, cols - visLen(prefix)))
	if (!prefix || content.length === 0) return content
	const indent = ' '.repeat(visLen(prefix))
	for (let i = 0; i < content.length; i++) {
		const line = content[i]!
		if (i === 0) content[i] = prefix + line
		else if (line && !blockText.standaloneHyperlink(blockText.stripAnsiSequences(line))) content[i] = indent + line
	}
	return content
}

function padBlock(lines: string[], fg: string, bg: string, bgIsBlack: boolean | undefined, cols: number): void {
	if (!bg || bgIsBlack) return
	lines.unshift(bgLine(`${fg} `, cols, bg))
	lines.push(bgLine(`${fg} `, cols, bg))
}

const fixedLabels = { log: '', info: '', warning: 'Warning', error: 'Error', fork: 'Fork' }

function blockLabel(block: Block, sessionLabel?: SessionLabel): string {
	if (block.type === 'log' && block.text.startsWith('Prompt queued')) return block.text.split('\n', 1)[0]!
	if (block.type === 'user') {
		if (block.canceled) return 'You (canceled)'
		if (block.source && block.source !== 'user' && block.source !== 'system') {
			let sender = transcriptTitles.senderLabel(block.source, block.sourceTab, block.sourceName)
			if (!block.sourceTab && !block.sourceName) sender = sessionLabel?.(block.source) ?? sender
			return `Message from ${sender}`
		}
		if (block.status === 'editing') return 'You (editing this prompt)'
		if (block.status === 'steering') return 'You (steering)'
		if (block.status === 'queued') return 'You (queued)'
		return 'You'
	}
	if (block.type === 'assistant') {
		// Synthetic messages are generated by Hal rather than the selected model.
		if (block.synthetic && block.canceled) return 'Hal (synthetic, canceled)'
		if (block.synthetic) return 'Hal (synthetic)'
		const display = models.displayModel(block.model)
		if (display && block.canceled) return `Hal (${display}, canceled)`
		if (display) return `Hal (${display})`
		if (block.canceled) return 'Hal (canceled)'
		return 'Hal'
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
		const output = block.toolSummary ? undefined : block.output
		const title = toolSpecs.getToolSpec(block.name).title?.(block.input, output, sessionLabel) ?? toolSpecs.humanizeName(block.name)
		return block.canceled && !block.toolSummary ? `${title} (canceled)` : title
	}
	if (block.type === 'question') return 'Question'
	return fixedLabels[block.type]
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
		if (visLen(beforeErase) < cols - 1) return [beforeErase + glyph + afterErase]
	}

	// Keep the final terminal column unused. Filling it enters delayed-autowrap
	// state on real terminals and can invalidate the renderer's cursor row.
	if (visLen(line) >= cols - 1) return [line, glyph]
	return [line + glyph]
}

function addInlineCursor(lines: string[], block: Block, cols: number, visible: boolean): void {
	const last = lines.at(-1)
	if (last == null) return
	lines.splice(lines.length - 1, 1, ...withInlineCursor(last, block, cols, visible))
}

export interface RenderedBlock {
	lines: string[]
	cursor?: { row: number; col: number }
}

function questionAnswer(block: Extract<Block, { type: 'question' }>): string {
	const answer = block.answer
	if (!answer) return ''
	if (answer.kind === 'choice') {
		if (block.input.kind !== 'choice') return 'Answered'
		const choice = block.input.choices.find((item) => item.id === answer.choiceId)
		return choice?.label ?? 'Answered'
	}
	if (answer.kind === 'text') return blockText.sanitizeTerminalText(answer.text).replace(/\s+/g, ' ').trim() || '(empty)'
	if (answer.kind === 'secret') return 'Secret provided'
	return 'Aborted'
}

function questionLabel(block: Extract<Block, { type: 'question' }>): string {
	const parts: string[] = []
	if (block.progress) parts.push(`Approval ${block.progress.index} of ${block.progress.total}`)
	else parts.push('Question')
	if (block.tool) {
		const title = toolSpecs.getToolSpec(block.tool.name).title?.(block.tool.input, undefined) ?? toolSpecs.humanizeName(block.tool.name)
		parts.push(title)
	}
	const answer = questionAnswer(block)
	if (answer) parts.push(answer)
	const text = blockText.sanitizeTerminalText(block.text).replace(/\s+/g, ' ').trim()
	if (!block.active && text) parts.push(text)
	return parts.join(' · ')
}

function renderQuestionBlock(block: Extract<Block, { type: 'question' }>, cols: number): RenderedBlock {
	const { fg, bg, bgIsBlack } = blockColors(block)
	const header = buildHeader(questionLabel(block), time.formatTimestamp(block.ts), '', cols)
	const lines = [bgLine(`${fg}${header}`, cols, bg)]
	if (!block.active) {
		lines[lines.length - 1]! += FG_OFF
		return { lines }
	}

	const contentCols = Math.max(1, cols - 1 - blocks.outputPad)
	lines.push(bgLine(`${fg} `, cols, bg))
	for (const line of wordWrap(expandTabs(blockText.sanitizeTerminalText(block.text), blockConfig.tabWidth), contentCols)) lines.push(bodyLine(line, fg, bg, cols))
	if (block.tool) {
		const details = blockContent({ type: 'tool', name: block.tool.name, input: block.tool.input }, contentCols)
		if (details.length > 0) lines.push(bgLine(`${fg} `, cols, bg))
		for (const line of details) lines.push(bodyLine(line, fg, bg, cols))
	}
	lines.push(bgLine(`${fg} `, cols, bg))

	let cursorTarget: { row: number; col: number } | undefined
	if (block.input.kind === 'choice') {
		const selected = terminalQuestions.choiceIndex(block)
		for (let index = 0; index < block.input.choices.length; index++) {
			const choice = block.input.choices[index]!
			let description = ''
			if (choice.description) description = ` — ${choice.description}`
			let marker = '○'
			if (index === selected) marker = '●'
			const text = `${marker} ${index + 1}. ${choice.label}${description}`
			const wrapped = wordWrap(expandTabs(blockText.sanitizeTerminalText(text), blockConfig.tabWidth), contentCols)
			if (index === selected) cursorTarget = { row: lines.length, col: blocks.outputPad + 1 }
			for (const line of wrapped) lines.push(bodyLine(line, fg, bg, cols))
		}
	} else if (block.input.kind === 'text') {
		const built = terminalQuestions.textRender(block, Math.max(1, contentCols - 2))
		if (built) {
			const empty = terminalQuestions.text(block) === ''
			for (let index = 0; index < built.lines.length; index++) {
				const prefix = index === 0 ? '> ' : '  '
				let line = built.lines[index]!
				if (empty && index === 0 && block.input.placeholder) line = clipVisual(expandTabs(blockText.sanitizeTerminalText(block.input.placeholder), blockConfig.tabWidth), Math.max(1, contentCols - 2))
				lines.push(bodyLine(prefix + line, fg, bg, cols))
			}
			cursorTarget = { row: lines.length - built.lines.length + built.cursor.rowOffset, col: blocks.outputPad + 3 + built.cursor.col }
		}
	} else {
		const masked = terminalQuestions.secretDisplay(block)
		const max = Math.max(1, contentCols - 2)
		const cursor = terminalQuestions.secretCursor(block)
		const start = Math.max(0, cursor - max)
		let shown = masked.slice(start, start + max)
		if (!shown && block.input.placeholder) shown = clipVisual(expandTabs(blockText.sanitizeTerminalText(block.input.placeholder), blockConfig.tabWidth), max)
		lines.push(bodyLine(`> ${shown}`, fg, bg, cols))
		cursorTarget = { row: lines.length - 1, col: blocks.outputPad + 3 + cursor - start }
	}
	const error = terminalQuestions.error(block)
	if (error) lines.push(bodyLine(error, fg, bg, cols))

	const beforePad = lines.length
	padBlock(lines, fg, bg, bgIsBlack, cols)
	if (cursorTarget && lines.length > beforePad) cursorTarget.row++
	lines[lines.length - 1]! += FG_OFF
	return { lines, cursor: cursorTarget }
}

function renderBlockDetailed(block: Block, cols: number, cursorVisible = false, sessionLabel?: SessionLabel): RenderedBlock {
	if (block.type === 'question') return renderQuestionBlock(block, cols)
	return { lines: blocks.renderBlock(block, cols, cursorVisible, sessionLabel) }
}

function renderBlock(block: Block, cols: number, cursorVisible = false, sessionLabel?: SessionLabel): string[] {

	const blobRef =
		'blobId' in block && 'sessionId' in block && block.blobId && block.sessionId
			? `${block.sessionId}/${block.blobId}`
			: ''
	const { fg, bg, bgIsBlack } = blockColors(block)
	const label = blockLabel(block, sessionLabel)
	const blockTime = time.formatTimestamp(block.ts)
	const header = buildHeader(label, blockTime, blobRef, cols, blocks.toolActivity(block))
	const plainNotice = block.type === 'info' || (block.type === 'log' && !block.text.startsWith('Prompt queued'))
	const lines: string[] = []
	if (!plainNotice) lines.push(bgLine(`${fg}${header}`, cols, bg))
	const contentCols = Math.max(1, cols - 1 - blocks.outputPad)
	const rawContent = plainNotice ? noticeContent(block, contentCols) : blockContent(block, contentCols)
	const content = blockText.hyperlinkUrls(rawContent, contentCols)
	if (content.length > 0 && !plainNotice && block.type !== 'tool') lines.push(bgLine(`${fg} `, cols, bg))
	for (const line of content) {
		const fullWidth = visLen(line) > contentCols
		const text = block.canceled ? `${STRIKE}${line}${STRIKE_OFF}` : line
		lines.push(bodyLine(text, fg, bg, cols, fullWidth))
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
	outputPad: 1,
	renderBlock,
	renderBlockDetailed,
	cursorColor,
	idleCursorColor,
	toolSpinner,
	toolActivity,
}
