// History rendering helpers extracted from render.ts.
//
// Important: renderer-owned caches still live in render.ts. This module stays
// focused on history formatting and grouping, and takes cache/config state as
// explicit input so the diff/fullscreen/cursor/cache state remains centralized.

import { oklch } from '../utils/oklch.ts'
import { blocks as blockRenderer } from '../cli/blocks.ts'
import { colors } from '../cli/colors.ts'
import { cursor } from '../cli/cursor.ts'
import type { Block, Tab } from '../client.ts'

export type BlockRenderCache = {
	version: number
	cols: number
	lines: string[]
}

export type HistoryRenderContext = {
	blockCache: WeakMap<Block, BlockRenderCache>
	cursorTick: number
	workingSessions: ReadonlyMap<string, boolean>
}

const config = {
	forkHistoryDimFactor: 0.85,
	halCursorFadeMs: 5000,
}

const LAST_ACTIVE_NOTICE_PREFIX = 'This session was last active '
let workingSeen = new Set<string>()
let fadeStart = new Map<string, number>()

function hasInlineHalCursor(block: Block | undefined): boolean {
	return (block?.type === 'assistant' || block?.type === 'thinking') && !!block.streaming
}

function renderEntry(block: Block, cols: number, context: HistoryRenderContext): string[] {
	// Streaming text/thinking blocks include the blinking HAL cursor. Do not cache
	// them across blink phases, even when the streamed text did not change.
	const streamingCursor = hasInlineHalCursor(block)
	const cached = streamingCursor ? undefined : context.blockCache.get(block)
	const version = block.renderVersion ?? 0
	if (cached && cached.version === version && cached.cols === cols) return cached.lines
	const slowCursorVisible = cursor.isVisible(context.cursorTick)
	const fastCursorVisible = cursor.isFastVisible(context.cursorTick)
	const lines = blockRenderer.renderBlock(block, cols, streamingCursor ? fastCursorVisible : slowCursorVisible)
	const rendered = block.dimmed ? lines.map((l) => oklch.dimAnsi(l, config.forkHistoryDimFactor)) : lines
	if (!streamingCursor) context.blockCache.set(block, { version, cols, lines: rendered })
	return rendered
}

function logGroupKey(block: Block): string | null {
	// Coalesce consecutive one-line log blocks, even across days. Multiline
	// output such as `/config` stays as a normal block so its line breaks survive.
	if (block.type !== 'log' || block.text.includes('\n')) return null
	if (block.text.startsWith(LAST_ACTIVE_NOTICE_PREFIX)) return null
	return 'log'
}

function renderGroup(group: Block[], cols: number, context: HistoryRenderContext): string[] {
	const lines = group.length === 1
		? renderEntry(group[0]!, cols, context)
		: blockRenderer.renderBlockGroup(group as Array<{ type: 'log' | 'warning' | 'error'; text: string; ts?: number; dimmed?: boolean }>, cols)
	// Dim grouped blocks if any block in the group is dimmed (groups are same-type, so all or none)
	return group[0]?.dimmed ? lines.map((l) => oklch.dimAnsi(l, config.forkHistoryDimFactor)) : lines
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

function renderLines(lines: string[], tab: Tab, cols: number, context: HistoryRenderContext): number {
	const start = lines.length
	const history = visibleHistory(tab.history)
	for (let i = 0; i < history.length; ) {
		const group = [history[i]!]
		const key = logGroupKey(group[0]!)
		if (key) {
			for (let j = i + 1; j < history.length && logGroupKey(history[j]!) === key; j++) {
				group.push(history[j]!)
			}
		}
		if (lines.length > 0 && history[i - 1]?.type === 'assistant' && group[0]?.type === 'assistant') lines.push('', `${colors.assistant.fg}${'─'.repeat(Math.max(0, cols))}\x1b[39m`, '')
		else if (lines.length > 0) lines.push('')
		const rendered = renderGroup(group, cols, context)
		lines.push(...rendered)
		i += group.length
	}

	const working = context.workingSessions.get(tab.sessionId) ?? false
	const last = history.at(-1)
	if (hasInlineHalCursor(last)) {
		// Streaming blocks carry an inline cursor, but still need breathing room
		// before the tab bar when they are the last visible history row.
		lines.push('')
	} else {
		// Prev-style idle HAL cursor: a blank row, a blinking cursor row, then
		// another blank row. When history fills the screen, these are the bottom
		// three history rows immediately above the tab/status/prompt chrome.
		lines.push('', halCursorLine(tab.sessionId, cursor.isVisible(context.cursorTick), working), '')
	}

	return lines.length - start
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
