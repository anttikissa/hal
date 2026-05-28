// Status/chrome rendering helpers extracted from render.ts.
//
// This module owns only presentation logic for the tab bar, status line,
// help bar, and prompt. Diff/fullscreen/cursor state still lives in render.ts.
//
// Eval-friendliness: every helper lives on the exported `renderStatus`
// namespace, and intra-module calls go through it. That way any helper
// (e.g. tokenUsageLabel) can be hot-patched at runtime without restart.

import { visLen, clipVisual } from '../utils/strings.ts'
import { oklch } from '../utils/oklch.ts'
import { helpBar } from '../cli/help-bar.ts'
import { client } from '../client.ts'
import { models } from '../models.ts'
import type { TokenUsage } from '../protocol.ts'
import { auth } from '../auth.ts'
import { openaiUsage } from '../openai-usage.ts'
import { anthropicUsage } from '../anthropic-usage.ts'
import { version } from '../version.ts'
import { HAL_DIR } from '../state.ts'
import { colors } from '../cli/colors.ts'
import { prompt } from '../cli/prompt.ts'
import { cursor } from '../cli/cursor.ts'
import type { Tab } from '../client.ts'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const BRIGHT_WHITE = '\x1b[97m'
const DIM = '\x1b[38;5;245m'
const RESET = '\x1b[0m'

type TabHelpHint = { text: string; priority: number }

const config = {
	showSession: true,
	showCwd: true,
	showModel: true,
	showContext: true,
	showServer: true,
	showTokenInOut: true,
	showTokenCache: false,
	showSubscription: true,
}

function halCursorColor(): string {
	// Match the main HAL cursor, including live colors.ason reloads and the
	// assistant-color fallback when no explicit input cursor color is configured.
	return colors.input.cursor || colors.assistant.fg
}

function inputStyle(): string {
	const bg = colors.input.bg || colors.user.bg || ''
	return `${bg}${colors.input.fg || BRIGHT_WHITE}`
}

function tabIndicator(tab: Tab): { char: string; color: string; blinks: boolean } {
	const busy = client.state.busy.get(tab.sessionId) ?? false
	if (client.state.toolConfirmPending.has(tab.sessionId)) return { char: '!', color: YELLOW, blinks: false }

	if (busy) return { char: '▪', color: renderStatus.halCursorColor(), blinks: true }

	// Alerts beat the generic "done unseen" checkmark. This matters for cases
	// like "Hit max iterations" where generation finished, but the tab still
	// needs attention.
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const b = tab.history[i]!
		// Skip trailing info blocks that aren't status-relevant.
		if ((b.type === 'log' || b.type === 'info') && b.text !== '[paused]' && !b.text?.startsWith('[interrupted]')) continue
		if (b.type === 'warning') return { char: '!', color: YELLOW, blinks: false }
		if (b.type === 'error') return { char: '✗', color: RED, blinks: true }
		if (b.type === 'log' && (b.text === '[paused]' || b.text?.startsWith('[interrupted]'))) {
			return { char: '!', color: '', blinks: true }
		}
		break
	}

	if (tab.doneUnseen) return { char: '✓', color: GREEN, blinks: false }

	return { char: '', color: '', blinks: false }
}

function hasAnimatedIndicators(): boolean {
	for (const tab of client.state.tabs) {
		if (renderStatus.tabIndicator(tab).blinks) return true
	}
	return false
}

function renderIndicator(tab: Tab, baseColor: string): string {
	const ind = renderStatus.tabIndicator(tab)
	if (!ind.char) return ''
	if (!ind.blinks || cursor.isVisible()) return `${ind.color}${ind.char}${baseColor}`
	const color = ind.color === renderStatus.halCursorColor() ? colors.input.cursorDim || ind.color : ind.color
	return `${color}${ind.char}${baseColor}`
}

function tabInner(num: number, ind: string): string {
	return `${num}${ind}`
}

function tabLabel(tab: Tab, i: number): string {
	const active = client.state.activeTab
	const base = i === active ? BRIGHT_WHITE : DIM
	const ind = renderStatus.renderIndicator(tab, base)
	const content = renderStatus.tabInner(i + 1, ind)
	if (i === active) return `${BRIGHT_WHITE}[${content}]${RESET}`
	return `${DIM} ${content} ${RESET}`
}

function tabHelpHints(tabCount: number): TabHelpHint[] {
	if (tabCount <= 1) {
		return [
			{ text: 'ctrl-t: new', priority: 2 },
			{ text: 'ctrl-f: fork', priority: 1 },
		]
	}
	return [
		{ text: 'alt-#: goto', priority: 5 },
		{ text: 'ctrl-n/p: switch', priority: 4 },
		{ text: 'ctrl-w: close', priority: 3 },
		{ text: 'ctrl-f: fork', priority: 2 },
		{ text: '/move n: reorder', priority: 1 },
	]
}

function joinTabHelpHints(hints: TabHelpHint[]): string {
	if (hints.length === 0) {
		return ''
	}
	let text = '  '
	for (let i = 0; i < hints.length; i++) {
		if (i > 0) {
			text += ', '
		}
		text += hints[i]!.text
	}
	return text
}

function tabHelpText(tabCount = client.state.tabs.length): string {
	return renderStatus.joinTabHelpHints(renderStatus.tabHelpHints(tabCount))
}

function fitTabHelpText(tabCount: number, base: string, cols: number): string {
	const width = renderStatus.contentWidth(cols)
	const hints = renderStatus.tabHelpHints(tabCount)
	while (hints.length > 0) {
		const help = renderStatus.joinTabHelpHints(hints)
		if (visLen(base) + visLen(help) <= width) {
			return help
		}

		let drop = 0
		for (let i = 1; i < hints.length; i++) {
			if (hints[i]!.priority <= hints[drop]!.priority) {
				drop = i
			}
		}
		hints.splice(drop, 1)
	}
	return ''
}

function buildTabText(): string {
	let text = ''
	for (let i = 0; i < client.state.tabs.length; i++) {
		text += renderStatus.tabLabel(client.state.tabs[i]!, i)
	}
	return text
}

function buildTabBarLines(cols: number): string[] {
	const tabText = renderStatus.buildTabText()
	const prefixed = `Tabs: ${tabText}`
	let content = prefixed + renderStatus.fitTabHelpText(client.state.tabs.length, prefixed, cols)
	if (visLen(content) > renderStatus.contentWidth(cols)) {
		content = tabText + renderStatus.fitTabHelpText(client.state.tabs.length, tabText, cols)
	}
	return [renderStatus.paddedLine(content, cols)]
}

function renderTabBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	lines.push(renderStatus.buildTabBarLines(cols)[0] ?? '')
}

// Shorten a path for display: replace $HOME with ~, then abbreviate.
function shortenPath(p: string): string {
	if (!p) return ''
	const home = process.env.HOME ?? ''
	if (home && p.startsWith(home)) p = '~' + p.slice(home.length)
	return p
}

function statusBaseColor(): string {
	return colors.status.fg || DIM
}

function statusHighlightColor(): string {
	return colors.status.highlight || BRIGHT_WHITE
}

function contentWidth(cols: number): number {
	return Math.max(0, cols - 2)
}

function paddedLine(content: string, cols: number): string {
	if (cols <= 0) return ''
	if (cols === 1) return ' '
	const width = renderStatus.contentWidth(cols)
	const clipped = visLen(content) > width ? clipVisual(content, width) : content
	return ` ${clipped}${' '.repeat(Math.max(0, width - visLen(clipped)))} `
}

function colorText(text: string, color: string, base: string): string {
	if (!text || !color) return text
	return `${color}${text}${base}`
}

function heatText(text: string, pct: number, base: string): string {
	return renderStatus.colorText(text, oklch.usageFg(pct), base)
}

function hasCustomSessionName(tab: Tab): boolean {
	return !!tab.name && tab.name !== tab.sessionId && !/^tab \d+$/i.test(tab.name)
}

function currentHalDir(): string {
	return process.env.HAL_DIR ?? HAL_DIR
}

function sessionStatusLabel(tab: Tab, base: string): string {
	if (!renderStatus.hasCustomSessionName(tab)) return tab.sessionId
	return `${tab.sessionId}: ${renderStatus.colorText(tab.name, renderStatus.statusHighlightColor(), base)}`
}

function cwdStatusLabel(tab: Tab, base: string): string {
	const cwd = renderStatus.shortenPath(tab.cwd)
	if (!cwd) return ''
	const color = tab.cwd === renderStatus.currentHalDir() ? colors.assistant.fg : renderStatus.statusHighlightColor()
	return renderStatus.colorText(cwd, color, base)
}

function modelStatusLabel(modelId: string, base: string): string {
	const display = models.displayModel(modelId)
	if (!display) return ''
	return renderStatus.colorText(display, renderStatus.statusHighlightColor(), base)
}

function contextStatusLabel(tab: Tab, base: string): string {
	if (tab.contextMax <= 0) return ''
	const pct = Math.round((tab.contextUsed / tab.contextMax) * 100)
	const used = renderStatus.heatText(models.formatTokenCount(tab.contextUsed), pct, base)
	const max = models.formatTokenCount(tab.contextMax)
	const percent = renderStatus.heatText(`${pct}%`, pct, base)
	return `${used}/${max} (${percent})`
}

function joinStatusParts(parts: string[]): string {
	return parts.filter(Boolean).join(' · ')
}

function hostMismatchBadge(): string {
	if (client.state.role !== 'client') return ''
	if (client.state.hostVersionStatus !== 'ready') return ''
	if (version.state.status !== 'ready') return ''
	if (!client.state.hostVersion || !version.state.combined) return ''
	return client.state.hostVersion === version.state.combined ? '' : ' ≠host'
}

function serverStatusLabel(): string {
	const badge = renderStatus.hostMismatchBadge()
	if (client.state.role === 'client') return `client${badge}`
	return 'server'
}

function formatTotalTokens(count: number): string {
	if (count < 1000) return count.toString()
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`
	if (count < 1000000) return `${Math.round(count / 1000)}k`
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
	return `${Math.round(count / 1000000)}M`
}

function tokenUsageLabel(usage: TokenUsage): string {
	const parts: string[] = []
	if (renderStatus.config.showTokenInOut) {
		if (usage.input) parts.push(`↑${renderStatus.formatTotalTokens(usage.input)}`)
		if (usage.output) parts.push(`↓${renderStatus.formatTotalTokens(usage.output)}`)
	}
	if (renderStatus.config.showTokenCache) {
		if (usage.cacheRead) parts.push(`R${renderStatus.formatTotalTokens(usage.cacheRead)}`)
		if (usage.cacheCreation) parts.push(`W${renderStatus.formatTotalTokens(usage.cacheCreation)}`)
	}
	return parts.join(' ')
}

function subscriptionStatusLabel(provider: string, base: string): string {
	let primaryPct: number | undefined
	let secondaryPct: number | undefined
	let index: number | undefined
	let total: number | undefined
	let secondaryLabel = '7d'
	if (provider === 'openai') {
		const current = openaiUsage.current()
		if (!current) return ''
		primaryPct = current.primary?.usedPercent
		secondaryPct = current.secondary?.usedPercent
		index = current.index
		total = current.total
	} else if (provider === 'anthropic') {
		const current = anthropicUsage.current()
		if (!current) return ''
		primaryPct = current.fiveHour?.usedPercent
		secondaryPct = current.sevenDay?.usedPercent
		index = current.index
		total = current.total
	} else {
		return ''
	}
	const windows: string[] = []
	if (primaryPct != null) {
		const pct = Math.round(primaryPct)
		windows.push(`5h ${renderStatus.heatText(`${pct}%`, pct, base)}`)
	}
	if (secondaryPct != null) {
		const pct = Math.round(secondaryPct)
		windows.push(`${secondaryLabel} ${renderStatus.heatText(`${pct}%`, pct, base)}`)
	}
	// Show the slot as index/total when multiple subscription accounts exist.
	const slot = index != null && total && total > 1 ? ` ${index + 1}/${total}` : ''
	if (windows.length === 0) return `Sub${slot}`
	return `Sub${slot}: ${windows.join(', ')}`
}

function renderStatusLine(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const base = renderStatus.statusBaseColor()
	const tab = client.currentTab()
	if (!tab) {
		lines.push(`${base}${renderStatus.paddedLine('', cols)}${RESET}`)
		return
	}

	const modelId = tab.model || models.defaultModel()
	const provider = models.providerName(modelId)
	const isSub = !auth.isApiKey(provider)
	const left = renderStatus.joinStatusParts([
		renderStatus.config.showSession ? renderStatus.sessionStatusLabel(tab, base) : '',
		renderStatus.config.showCwd ? renderStatus.cwdStatusLabel(tab, base) : '',
		renderStatus.config.showModel ? renderStatus.modelStatusLabel(modelId, base) : '',
		renderStatus.config.showContext ? renderStatus.contextStatusLabel(tab, base) : '',
	])

	const server = renderStatus.config.showServer ? renderStatus.serverStatusLabel() : ''
	const tokenLabel = renderStatus.tokenUsageLabel(tab.usage)
	const plan = renderStatus.config.showSubscription && isSub ? renderStatus.subscriptionStatusLabel(provider, base) : ''
	const innerWidth = renderStatus.contentWidth(cols)
	let showServer = !!server
	let showTokens = !!tokenLabel
	let showPlan = !!plan
	let inner = ''

	while (true) {
		const right = renderStatus.joinStatusParts([
			showServer ? server : '',
			showTokens ? tokenLabel : '',
			showPlan ? plan : '',
		])
		const needsDrop = right && innerWidth - visLen(left) - visLen(right) < 1
		if (needsDrop) {
			if (showPlan) {
				showPlan = false
				continue
			}
			if (showTokens) {
				showTokens = false
				continue
			}
			if (showServer) {
				showServer = false
				continue
			}
		}

		if (!right) {
			const clippedLeft = visLen(left) > innerWidth ? clipVisual(left, innerWidth) : left
			inner = clippedLeft + ' '.repeat(Math.max(0, innerWidth - visLen(clippedLeft)))
			break
		}

		const maxLeft = Math.max(0, innerWidth - visLen(right) - 1)
		const clippedLeft = visLen(left) > maxLeft ? clipVisual(left, maxLeft) : left
		const gap = Math.max(1, innerWidth - visLen(clippedLeft) - visLen(right))
		inner = clippedLeft + ' '.repeat(gap) + right
		break
	}

	lines.push(`${base}${renderStatus.paddedLine(inner, cols)}${RESET}`)
}

function renderHelpBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const busy = client.isBusy()
	const hasText = prompt.text().trim().length > 0
	const continueAction = client.continueActionForCurrentTurn()
	const desc = colors.help.description || '\x1b[90m'
	const style = {
		key: colors.help.key || '\x1b[37m',
		description: desc,
		separator: desc,
	}
	const baseLeft = helpBar.build(busy, hasText, continueAction, style)
	const resizeHint = prompt.resizeHint(cols)
	const resizeText = resizeHint ? `${style.key}ctrl-=/-${style.description}: ${resizeHint}` : ''
	const separator = `${style.separator}, `
	const left = baseLeft && resizeText ? `${resizeText}${separator}${baseLeft}` : baseLeft || resizeText
	const right = helpBar.shortcutListHint(style)
	let bar = left
	if (right) {
		const innerWidth = renderStatus.contentWidth(cols)
		const maxLeft = Math.max(0, innerWidth - visLen(right) - 1)
		const clippedLeft = visLen(left) > maxLeft ? clipVisual(left, maxLeft) : left
		const gap = Math.max(1, innerWidth - visLen(clippedLeft) - visLen(right))
		bar = clippedLeft ? `${clippedLeft}${' '.repeat(gap)}${right}` : `${' '.repeat(Math.max(0, innerWidth - visLen(right)))}${right}`
	}
	// Always push a line — even when empty — so chrome height is constant.
	// Without this, typing the first character causes a 1-row jump.
	lines.push(`${renderStatus.paddedLine(bar, cols)}${RESET}`)
}

function promptContentWidth(cols: number): number {
	return renderStatus.contentWidth(cols)
}

function promptRule(cols: number): string {
	return `${renderStatus.inputStyle()}${'─'.repeat(Math.max(0, cols))}${RESET}`
}

function paddedPromptLine(line: string, cols: number): string {
	return `${renderStatus.inputStyle()}${renderStatus.paddedLine(line, cols)}${RESET}`
}

function renderPrompt(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const p = prompt.buildPrompt(renderStatus.promptContentWidth(cols))
	lines.push(renderStatus.promptRule(cols))
	for (const line of p.lines) lines.push(renderStatus.paddedPromptLine(line, cols))
	lines.push(renderStatus.promptRule(cols))
}

// How many frame lines the chrome (tab bar + prompt box + status + help) occupies.
// Help bar always counts as 1 line (even when empty) to prevent jumps.
function chromeLines(): number {
	const cols = process.stdout.columns || 80
	return renderStatus.buildTabBarLines(cols).length + 4 + prompt.buildPrompt(renderStatus.promptContentWidth(cols)).lines.length
}

export const renderStatus = {
	config,
	// Public (called from render.ts and elsewhere)
	chromeLines,
	hasAnimatedIndicators,
	renderTabBar,
	renderStatusLine,
	renderHelpBar,
	renderPrompt,
	// Internal helpers, exposed on the namespace for hot-patching via eval.
	inputStyle,
	contentWidth,
	paddedLine,
	halCursorColor,
	tabIndicator,
	renderIndicator,
	tabInner,
	tabLabel,
	tabHelpText,
	tabHelpHints,
	joinTabHelpHints,
	fitTabHelpText,
	buildTabText,
	buildTabBarLines,
	shortenPath,
	statusBaseColor,
	statusHighlightColor,
	colorText,
	heatText,
	hasCustomSessionName,
	currentHalDir,
	sessionStatusLabel,
	cwdStatusLabel,
	modelStatusLabel,
	contextStatusLabel,
	joinStatusParts,
	hostMismatchBadge,
	serverStatusLabel,
	formatTotalTokens,
	tokenUsageLabel,
	subscriptionStatusLabel,
	promptContentWidth,
	promptRule,
	paddedPromptLine,
}
