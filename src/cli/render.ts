// Frame rendering — builds the full terminal frame.

import type { CursorPos } from './diff-engine.ts'
import { cursor } from './cursor.ts'
import { prompt } from './prompt.ts'
import { blocks as blockViews, type Block } from './blocks.ts'
import { heights } from './heights.ts'
import { blocksFingerprint } from './block-fingerprint.ts'
import { config } from '../config.ts'
import { models } from '../models.ts'
import { tabline } from './tabline.ts'
import * as colors from './colors.ts'
import { strings } from '../utils/strings.ts'
import type { TabState, ClientState } from '../client.ts'

const { stdout } = process

const DIM = '\x1b[38;5;245m', RESET = '\x1b[0m', YELLOW = '\x1b[33m', RED = '\x1b[31m', GREEN = '\x1b[32m'

function cols(): number { return stdout.columns || 80 }
export function contentWidth(): number { return cols() - 2 }

function oneLine(s: string): string {
	return s.replace(/\s*\r?\n+\s*/g, ' ').replace(/\s+/g, ' ')
}

function shortModel(model?: string): string {
	return models.displayModel(model || config.getConfig().defaultModel)
}

function deriveState(tab: TabState | null): string {
	if (!tab) return 'idle'
	if (tab.pausing) return 'pausing'
	if (!tab.busy) return 'idle'
	const last = tab.blocks[tab.blocks.length - 1]
	if (!last) return 'idle'
	if (last.type === 'thinking' && !last.done) return 'thinking'
	if (last.type === 'tool' && (last.status === 'running' || last.status === 'streaming')) return 'tool'
	return 'writing'
}

function fmtContextPlain(ctx?: { used: number; max: number; estimated?: boolean }): { text: string; pctColor: string } | null {
	if (!ctx || ctx.max <= 0) return null
	const pctNum = ctx.used / ctx.max
	const pct = `${ctx.estimated ? '~' : ''}${(pctNum * 100).toFixed(1)}%`
	const max = ctx.max >= 1000 ? `${Math.round(ctx.max / 1000)}k` : String(ctx.max)
	const pctColor = pctNum >= 0.70 ? RED : pctNum >= 0.50 ? YELLOW : GREEN
	return { text: `${pct}/${max}`, pctColor }
}

function buildSeparator(tab: TabState | null, w: number, isHost: boolean, scrollInfo?: string): string {
	const { fg: iFg } = colors.input
	const model = shortModel(tab?.info.model)
	const state = deriveState(tab)
	const role = isHost ? 'host' : 'client'
	const ctxInfo = fmtContextPlain(tab?.context)

	const rightParts = [role]
	if (tab?.sessionId) rightParts.push(tab.sessionId)
	if (ctxInfo) rightParts.push(ctxInfo.text)
	if (scrollInfo) rightParts.push(scrollInfo)

	const prefix = '── '
	const label = `You › Hal (${model}, ${state})`
	const suffix = ` ${rightParts.join(' · ')} ──`
	const iw = w
	const maxLabel = Math.max(1, iw - prefix.length - suffix.length - 1)
	const shown = label.length > maxLabel ? label.slice(0, maxLabel) : label
	const lead = `${prefix}${shown} `
	const fill = '─'.repeat(Math.max(1, iw - lead.length - suffix.length))
	const inner = lead + fill + suffix

	let colored = `${iFg}${inner}`
	if (ctxInfo) {
		const pctSlash = ctxInfo.text
		const idx = colored.lastIndexOf(pctSlash)
		if (idx >= 0) {
			const pctOnly = pctSlash.split('/')[0]
			colored = colored.slice(0, idx) + ctxInfo.pctColor + pctOnly + iFg + '/' + pctSlash.split('/')[1] + colored.slice(idx + pctSlash.length)
		}
	}

	return `${colored}${RESET}`
}

function minicursorColor(block: Block): string | undefined {
	if (block.type === 'tool' && (block.status === 'streaming' || block.status === 'running')) return colors.tool(block.name).fg
	if (block.type === 'thinking' && !block.done) return colors.thinking.fg
	return undefined
}

interface ContentRenderCacheEntry {
	sessionId: string | null
	width: number
	cursorVisible: boolean
	fingerprint: number
	lines: string[]
}

let contentRenderCache: ContentRenderCacheEntry | null = null

function renderContentLines(tab: TabState | null, width: number, cursorVisible: boolean): string[] {
	const blocks = tab?.blocks ?? []
	const sessionId = tab?.sessionId ?? null
	const fingerprint = blocksFingerprint(blocks)
	const cached = contentRenderCache
	if (
		cached
		&& cached.sessionId === sessionId
		&& cached.width === width
		&& cached.cursorVisible === cursorVisible
		&& cached.fingerprint === fingerprint
	) {
		return cached.lines
	}
	const lines = blockViews.renderBlocks(blocks, width, cursorVisible).lines
	contentRenderCache = { sessionId, width, cursorVisible, fingerprint, lines }
	return lines
}

function buildLines(cState: ClientState, tab: TabState | null, isHost: boolean): { lines: string[]; cursor: CursorPos } {
	const w = cols()
	const cw = contentWidth()
	const rows = stdout.rows || 24

	const cursorVisible = cursor.isVisible()
	const hasQ = prompt.hasQuestion()
	const contentLines = renderContentLines(tab, w, cursorVisible)

	const lines: string[] = []
	let qAnswerStartRow = -1
	let qPromptResult: ReturnType<typeof prompt.buildPrompt> | null = null

	if (hasQ) {
		// Strip trailing idle cursor lines (empty/█/empty) from content
		let trimmed = contentLines
		if (trimmed.length >= 3) {
			trimmed = trimmed.slice(0, -3)
		}
		lines.push(...trimmed)
		if (lines.length > 0) lines.push('')

		// Question block (tool-like box) — part of content area, above tab bar
		const qLabel = prompt.getQuestionLabel()!
		const qLines = blockViews.renderQuestion(qLabel, w)
		lines.push(...qLines)

		// Answer input area
		qPromptResult = prompt.buildPrompt(cw)
		qAnswerStartRow = lines.length
		lines.push(...qPromptResult.lines)
		lines.push('') // spacing after answer input
		// Help bar below answer input
		const qHelp = ' enter to submit '
		const qhPad = Math.max(0, w - strings.visLen(qHelp))
		const qhLeft = Math.floor(qhPad / 2)
		const qhRight = qhPad - qhLeft
		lines.push(`${DIM}${'─'.repeat(qhLeft)}${qHelp}${'─'.repeat(qhRight)}${RESET}`)
		// Pad to push tab bar + chrome to bottom of screen
		const frozenRaw = prompt.frozenText() ?? ''
		const frozenSplit = frozenRaw.split('\n').slice(0, 3)
		const frozenCount = (!frozenSplit.length || (frozenSplit.length === 1 && !frozenSplit[0])) ? 1 : frozenSplit.length
		// chrome below: tab bar(1) + separator(1) + frozen prompt + help bar(1)
		const chromeBelow = 1 + 1 + frozenCount + 1
		const padTarget = Math.max(0, rows - chromeBelow)
		while (lines.length < padTarget) lines.push('')
	} else {
		lines.push(...contentLines)
		// Pad to tallest tab's content height (keeps prompt position stable)
		const activeSessionId = tab?.sessionId ?? null
		const maxHeight = heights.maxTabHeight(cState.tabs, activeSessionId, w, contentLines.length)
		const pLines = prompt.lineCount(cw)
		// tab bar(1) + help bar(1) + prompt sep(1) + prompt lines
		const chromeLines = 3 + pLines
		const available = Math.max(0, rows - chromeLines)
		const padTarget = Math.min(maxHeight, available)
		while (lines.length < padTarget) lines.push('')
	}

	// Tab bar
	const tabs = cState.tabs
	const idx = cState.activeTabIndex
	const parts = tabs.map((t, i) => {
		const title = t.info.topic ?? t.info.workingDir?.split('/').pop() ?? 'tab'
		let indicator: string | undefined
		// Look past trailing info blocks (e.g. '/continue to retry') to find status-determining block
		let last: Block | undefined
		for (let j = t.blocks.length - 1; j >= 0; j--) {
			const b = t.blocks[j]
			if (b.type !== 'info') { last = b; break }
			if (b.text === '[paused]' || b.text.startsWith('[interrupted]')) { last = b; break }
		}
		if (t.question) indicator = `${colors.question.fg}?`
		else if (!t.busy && last?.type === 'error') indicator = `${colors.error.fg}✖`
		else if (!t.busy && last?.type === 'info' && (last.text === '[paused]' || last.text.startsWith('[interrupted]')))
			indicator = '!'
		else if (t.doneUnseen) indicator = '\x1b[32m✓'
		const actualLast = t.blocks[t.blocks.length - 1]
		const cc = t.busy && actualLast ? minicursorColor(actualLast) : undefined
		return {
			label: `${i + 1} ${title}`,
			busy: !!t.busy,
			active: i === idx,
			cursorColor: cc,
			indicator,
		}
	})
	const tabBar = tabline.renderTabline(parts, w, cursorVisible)
	lines.push(tabBar)

	let cursorPos: CursorPos

	if (hasQ && qPromptResult) {
		// Below tab bar: grayed-out separator + frozen main prompt (not editable)
		lines.push(buildSeparator(tab, w, isHost, tab?.loadingHistory ? 'loading history' : undefined))
		const frozen = prompt.frozenText() ?? ''
		const frozenLines = frozen.split('\n')
		const shown = frozenLines.slice(0, 3)
		if (shown.length === 0 || (shown.length === 1 && shown[0] === '')) {
			lines.push(`${DIM} ${RESET}`)
		} else {
			for (const l of shown) lines.push(`${DIM} ${l}${RESET}`)
		}
		// Cursor is in the answer prompt area above tab bar
		cursorPos = { row: qAnswerStartRow + qPromptResult.cursor.rowOffset, col: qPromptResult.cursor.col }
	} else {
		// Normal prompt
		const p = prompt.buildPrompt(cw)
		const pLines = prompt.lineCount(cw)
		const sepParts: string[] = []
		if (tab?.loadingHistory) sepParts.push('loading history')
		if (p.scrollInfo) sepParts.push(p.scrollInfo)
		lines.push(buildSeparator(tab, w, isHost, sepParts.length > 0 ? sepParts.join(' · ') : undefined))
		lines.push(...p.lines)
		cursorPos = {
			row: lines.length - pLines + p.cursor.rowOffset,
			col: p.cursor.col,
		}
	}

	// Help bar
	const statusText = tab?.busy ? ' busy' : ''
	const help = ` ctrl-t new │ ctrl-w close │ ctrl-n/p switch │ ctrl-l redraw │ ctrl-c quit${statusText} `
	const safeHelp = strings.clipVisual(oneLine(help), w)
	const hPad = Math.max(0, w - safeHelp.length)
	const hLeft = Math.max(0, Math.floor(hPad / 2))
	const hRight = Math.max(0, hPad - hLeft)
	lines.push(`${DIM}${'─'.repeat(hLeft)}${safeHelp}${'─'.repeat(hRight)}${RESET}`)
	return { lines, cursor: cursorPos }
}

export const render = { contentWidth, buildLines }
