// Transcript/history renderer used by render.ts.
//
// render.ts owns the whole terminal frame and diff engine. This module only turns
// a tab's historical blocks into rows for the history area: block rendering,
// grouping, hidden paused notices, assistant separators, fork-history dimming,
// and the idle/working inline HAL cursor.
//
// The separation keeps transcript semantics here while terminal mechanics stay
// in render.ts. Renderer-owned cache state is still allocated by render.ts and
// passed in so reset/diff/fullscreen behavior remains centralized.

import { oklch } from '../../utils/oklch.ts'
import { blocks as blockRenderer, type RenderedBlock } from './blocks.ts'
import { terminalQuestions } from './questions.ts'
import { colors } from './colors.ts'
import { cursor } from './cursor.ts'
import type { Block, Tab } from '../app.ts'

export type BlockRenderCache = {
	version: number
	cols: number
	lines: string[]
	sessionLabelVersion: number
}

export type HistoryRenderContext = {
	blockCache: WeakMap<Block, BlockRenderCache>
	cursorTick: number
	workingSessions: ReadonlyMap<string, boolean>
	sessionLabel: (sessionId: string) => string
	sessionLabelVersion: number
}

const config = {
	forkHistoryDimFactor: 0.82,
	halCursorFadeMs: 5000,
}

const LAST_ACTIVE_NOTICE_PREFIX = 'This session was last active '
let workingSeen = new Set<string>()
let fadeStart = new Map<string, number>()
const bodyCache = new WeakMap<Tab, { key: string; lines: string[]; streaming: boolean; cursor?: { row: number; col: number } }>()

function hasInlineHalCursor(block: Block | undefined): boolean {
	return (block?.type === 'assistant' || block?.type === 'thinking') && !!block.streaming
}

function renderEntry(block: Block, cols: number, context: HistoryRenderContext, activeStreamingBlock: Block | undefined): RenderedBlock {
	// Only the current active stream includes the blinking HAL cursor. Do not cache
	// it across blink phases, even when the streamed text did not change.
	const streamingCursor = block === activeStreamingBlock
	let renderedBlock = block
	if ((block.type === 'assistant' || block.type === 'thinking') && block.streaming && !streamingCursor) renderedBlock = { ...block, streaming: false }
	const cached = streamingCursor || block.type === 'question' ? undefined : context.blockCache.get(block)
	const version = block.renderVersion ?? 0
	if (cached && cached.version === version && cached.cols === cols && cached.sessionLabelVersion === context.sessionLabelVersion) return { lines: cached.lines }
	const fastCursorVisible = cursor.isFastVisible(context.cursorTick)
	const rendered = blockRenderer.renderBlockDetailed(renderedBlock, cols, streamingCursor && fastCursorVisible, context.sessionLabel)
	const lines = block.dimmed ? rendered.lines.map((line) => oklch.dimAnsi(line, config.forkHistoryDimFactor)) : rendered.lines
	if (!streamingCursor && block.type !== 'question') context.blockCache.set(block, { version, cols, lines, sessionLabelVersion: context.sessionLabelVersion })
	return { lines, cursor: rendered.cursor }
}

function logGroupKey(block: Block): string | null {
	// Coalesce consecutive one-line log blocks, even across days. Multiline
	// output such as `/config` stays as a normal block so its line breaks survive.
	if (block.type !== 'log' || block.text.includes('\n')) return null
	if (block.text.startsWith(LAST_ACTIVE_NOTICE_PREFIX)) return null
	return 'log'
}

function renderGroup(group: Block[], cols: number, context: HistoryRenderContext, activeStreamingBlock: Block | undefined): RenderedBlock {
	if (group.length === 1) return renderEntry(group[0]!, cols, context, activeStreamingBlock)
	let lines = blockRenderer.renderBlockGroup(group as Array<{ type: 'log' | 'warning' | 'error'; text: string; ts?: number; dimmed?: boolean }>, cols, context.sessionLabel)
	// Dim grouped blocks if any block in the group is dimmed (groups are same-type, so all or none)
	if (group[0]?.dimmed) lines = lines.map((line) => oklch.dimAnsi(line, config.forkHistoryDimFactor))
	return { lines }
}

function shouldHideBlock(history: Block[], index: number): boolean {
	const block = history[index]
	if (!block) return false

	// Steering already tells the user why generation stopped. Hiding the
	// immediately preceding [paused] notice keeps the history focused on the
	// steering prompt instead of showing a redundant status block right before it.
	if (block.type !== 'log' || block.text !== '[paused]') return false
	const next = history[index + 1]
	if (next?.type === 'user' && next.status === 'steering') return true
	return next?.type === 'info' && next.text.startsWith('Paused. ') && next.text.includes('queued prompt')
}

function visibleHistory(history: Block[]): Block[] {
	const visible: Block[] = []
	for (let i = 0; i < history.length; i++) {
		if (shouldHideBlock(history, i)) continue
		visible.push(history[i]!)
	}
	return visible
}

function fadeAmount(sessionId: string, working: boolean, fadeMs: number): number {
	if (working) {
		workingSeen.add(sessionId)
		fadeStart.delete(sessionId)
		return 0
	}
	if (fadeMs <= 0) return 1
	if (workingSeen.has(sessionId) && !fadeStart.has(sessionId)) fadeStart.set(sessionId, Date.now())
	const start = fadeStart.get(sessionId)
	return start == null ? 1 : Math.min(1, (Date.now() - start) / fadeMs)
}

function halCursorLine(sessionId: string, visible: boolean, working: boolean): string {
	const t = fadeAmount(sessionId, working, config.halCursorFadeMs)
	const color = working ? blockRenderer.cursorColor() : oklch.mixFg(blockRenderer.cursorColor(), blockRenderer.idleCursorColor(), t)
	return visible ? ` ${color}█\x1b[39m` : ''
}

export interface HistoryRenderResult {
	height: number
	cursor?: { row: number; col: number }
}

function renderLines(lines: string[], tab: Tab, cols: number, context: HistoryRenderContext): HistoryRenderResult {
	const start = lines.length
	const working = context.workingSessions.get(tab.sessionId) ?? false
	// Everything above the cursor depends only on these. Rebuilding it per paint meant
	// walking the whole history on every keystroke and every stream delta from any tab.
	// Streaming mutates the last block in place and bumps renderVersion without touching
	// historyVersion, so the tail's identity has to be part of the key.
	const tail = tab.history.at(-1)
	const key = `${tab.sessionId}:${tab.historyVersion}:${cols}:${blockRenderer.outputPad}:${working}:${context.sessionLabelVersion}:${tab.history.length}:${tail?.renderVersion ?? 0}:${terminalQuestions.state.version}`
	let body = bodyCache.get(tab)
	if (!body || body.key !== key || (working && body.streaming)) {
		const history = visibleHistory(tab.history)
		const last = history.at(-1)
		let activeStreamingBlock: Block | undefined
		if (working && hasInlineHalCursor(last)) activeStreamingBlock = last
		const built: string[] = []
		let questionCursor: { row: number; col: number } | undefined
		for (let i = 0; i < history.length; ) {
			const group = [history[i]!]
			const groupKey = logGroupKey(group[0]!)
			if (groupKey) {
				for (let j = i + 1; j < history.length && logGroupKey(history[j]!) === groupKey; j++) group.push(history[j]!)
			}
			if (built.length > 0 && history[i - 1]?.type === 'assistant' && group[0]?.type === 'assistant') built.push('', `${colors.assistant.fg}${'─'.repeat(Math.max(0, cols))}\x1b[39m`, '')
			else if (built.length > 0) built.push('')
			const rendered = renderGroup(group, cols, context, activeStreamingBlock)
			if (rendered.cursor) questionCursor = { row: built.length + rendered.cursor.row, col: rendered.cursor.col }
			built.push(...rendered.lines)
			i += group.length
		}
		body = { key, lines: built, streaming: !!activeStreamingBlock, cursor: questionCursor }
		bodyCache.set(tab, body)
	}
	lines.push(...body.lines)
	const questionCursor = body.cursor ? { row: start + body.cursor.row, col: body.cursor.col } : undefined

	if (body.streaming || questionCursor) {
		// Streaming and question blocks own their cursors and only need breathing room
		// before the tab bar.
		lines.push('')
	} else {
		// Prev-style idle HAL cursor: a blank row, a blinking cursor row, then
		// another blank row. When history fills the screen, these are the bottom
		// three history rows immediately above the tab/status/prompt chrome.
		lines.push('', halCursorLine(tab.sessionId, cursor.isVisible(context.cursorTick), working), '')
	}

	return { height: lines.length - start, cursor: questionCursor }
}

function hasFadingCursor(tab: Tab | null | undefined): boolean {
	const start = tab ? fadeStart.get(tab.sessionId) : undefined
	return start != null && config.halCursorFadeMs > 0 && Date.now() - start < config.halCursorFadeMs
}

function resetAnimation(): void {
	workingSeen = new Set()
	fadeStart = new Map()
}

function hasAnimatedCursor(tab: Tab | null | undefined): boolean {
	return !!tab
}

export const renderHistory = { config, renderLines, hasAnimatedCursor, hasFadingCursor, resetAnimation }
