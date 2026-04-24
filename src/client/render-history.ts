// History rendering helpers extracted from render.ts.
//
// Important: renderer-owned caches still live in render.ts. This module stays
// focused on history formatting and grouping, and takes cache/config state as
// explicit input so the diff/fullscreen/cursor/cache state remains centralized.

import { oklch } from '../utils/oklch.ts'
import { blocks as blockRenderer } from '../cli/blocks.ts'
import type { Block, Tab } from '../client.ts'

export type BlockRenderCache = {
	version: number
	cols: number
	lines: string[]
}

export type HistoryRenderContext = {
	forkHistoryDimFactor: number
	blockCache: WeakMap<Block, BlockRenderCache>
	cursorVisible: boolean
}

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
	const lines = blockRenderer.renderBlock(block, cols, context.cursorVisible)
	const rendered = block.dimmed ? lines.map((l) => oklch.dimAnsi(l, context.forkHistoryDimFactor)) : lines
	if (!streamingCursor) context.blockCache.set(block, { version, cols, lines: rendered })
	return rendered
}

function infoGroupKey(block: Block): string | null {
	// Only coalesce simple one-line info blocks. Multiline output such as
	// `/config` should render as a normal block so its internal line breaks
	// survive instead of being flattened into bracket "bricks".
	if (block.type !== 'info' || !block.ts || block.text.includes('\n')) return null
	const d = new Date(block.ts)
	return `info:${d.getHours()}:${d.getMinutes()}`
}

function renderGroup(group: Block[], cols: number, context: HistoryRenderContext): string[] {
	const lines = group.length === 1
		? renderEntry(group[0]!, cols, context)
		: blockRenderer.renderBlockGroup(group as Array<{ type: 'info' | 'warning' | 'error'; text: string; ts?: number; dimmed?: boolean }>, cols)
	// Dim grouped blocks if any block in the group is dimmed (groups are same-type, so all or none)
	return group[0]?.dimmed ? lines.map((l) => oklch.dimAnsi(l, context.forkHistoryDimFactor)) : lines
}

function shouldHideBlock(history: Block[], index: number): boolean {
	const block = history[index]
	if (!block) return false

	// Steering already tells the user why generation stopped. Hiding the
	// immediately preceding [paused] notice keeps the history focused on the
	// steering prompt instead of showing a redundant status block right before it.
	if (block.type !== 'info' || block.text !== '[paused]') return false
	const next = history[index + 1]
	return next?.type === 'user' && next.status === 'steering'
}

function visibleHistory(history: Block[]): Block[] {
	const visible: Block[] = []
	for (let i = 0; i < history.length; i++) {
		if (shouldHideBlock(history, i)) continue
		visible.push(history[i]!)
	}
	return visible
}

function halCursorLine(visible: boolean): string {
	return visible ? `${blockRenderer.cursorColor()}█\x1b[39m` : ''
}

function renderLines(lines: string[], tab: Tab, cols: number, context: HistoryRenderContext): number {
	const start = lines.length
	const history = visibleHistory(tab.history)
	for (let i = 0; i < history.length; ) {
		const group = [history[i]!]
		const key = infoGroupKey(group[0]!)
		if (key) {
			for (let j = i + 1; j < history.length && infoGroupKey(history[j]!) === key; j++) {
				group.push(history[j]!)
			}
		}
		if (lines.length > 0) lines.push('')
		const rendered = renderGroup(group, cols, context)
		lines.push(...rendered)
		i += group.length
	}

	// Prev-style idle HAL cursor: a blank row, a blinking cursor row, then
	// another blank row. When history fills the screen, these are the bottom
	// three history rows immediately above the tab/status/prompt chrome.
	if (!hasInlineHalCursor(history.at(-1))) {
		lines.push('', halCursorLine(context.cursorVisible), '')
	}

	return lines.length - start
}

function hasAnimatedCursor(tab: Tab | null | undefined): boolean {
	return !!tab
}

export const renderHistory = { renderLines, hasAnimatedCursor }
