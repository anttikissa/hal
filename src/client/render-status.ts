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
const ANSI_DIM = '\x1b[2m'

type TabLabelMode = 'wide' | 'name' | 'num'
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

function tabIndicator(tab: Tab): { char: string; color: string; blinks: boolean } {
	const busy = client.state.busy.get(tab.sessionId) ?? false

	if (busy) return { char: '▪', color: renderStatus.halCursorColor(), blinks: true }

	// Alerts beat the generic "done unseen" checkmark. This matters for cases
	// like "Hit max iterations" where generation finished, but the tab still
	// needs attention.
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const b = tab.history[i]!
		// Skip trailing info blocks that aren't status-relevant.
		if (b.type === 'info' && b.text !== '[paused]' && !b.text?.startsWith('[interrupted]')) continue
		if (b.type === 'warning') return { char: '!', color: YELLOW, blinks: false }
		if (b.type === 'error') return { char: '✗', color: RED, blinks: true }
		if (b.type === 'info' && (b.text === '[paused]' || b.text?.startsWith('[interrupted]'))) {
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

// Render the 1-char indicator. Animated indicators pulse between bright and dim
// phases instead of disappearing, so a busy tab never looks idle.
function renderIndicator(tab: Tab, baseColor: string): string {
	const ind = renderStatus.tabIndicator(tab)
	if (!ind.char) return ''
	if (!ind.blinks || cursor.isVisible()) return `${ind.color}${ind.char}${baseColor}`
	return `${ANSI_DIM}${ind.color}${ind.char}${RESET}${baseColor}`
}

function tabDir(tab: Tab): string {
	return tab.cwd.split('/').filter(Boolean).pop() ?? ''
}

function tabInner(num: number, ind: string, text?: string): string {
	if (text) return `${num}${ind || ' '}${text}`
	return `${num}${ind}`
}

// Tab bar: prefers [n dir name], wrapping once before falling back to shorter labels.
// Each tab shows a 1-char status indicator between the number and title.
function tabLabel(tab: Tab, i: number, mode: TabLabelMode): string {
	const active = client.state.activeTab
	const ind = renderStatus.renderIndicator(tab, i === active ? BRIGHT_WHITE : DIM)
	const name = tab.name || tab.sessionId
	const dir = renderStatus.tabDir(tab)
	const text = mode === 'wide'
		? (dir && dir !== name ? `${dir} ${name}` : name)
		: mode === 'name'
			? name
			: ''
	const content = renderStatus.tabInner(i + 1, ind, text)
	if (i === active) return `${BRIGHT_WHITE}[${content}]${RESET}`
	return `${DIM} ${content} ${RESET}`
}

function wrapTabLabels(labels: string[], cols: number): string[] | null {
	if (labels.length === 0) return ['']
	const lines: string[] = []
	let line = ''
	for (const label of labels) {
		if (visLen(label) > cols) return null
		if (!line || visLen(line) + visLen(label) <= cols) {
			line += label
			continue
		}
		lines.push(line)
		if (lines.length >= 2) return null
		line = label
	}
	if (line) lines.push(line)
	return lines
}

function buildTabBarLines(cols: number): string[] {
	const tabs = client.state.tabs
	for (const mode of ['wide', 'name', 'num'] as const) {
		const rendered = tabs.map((tab, i) => renderStatus.tabLabel(tab, i, mode))
		const joined = rendered.join('')
		if (visLen(joined) <= cols) return [joined]
	}

	for (const mode of ['name', 'num'] as const) {
		const wrapped = renderStatus.wrapTabLabels(tabs.map((tab, i) => renderStatus.tabLabel(tab, i, mode)), cols)
		if (wrapped) return wrapped
	}

	const terse = tabs.map((tab, i) => renderStatus.tabLabel(tab, i, 'num'))
	return [clipVisual(terse.join(''), cols)]
}

function renderTabBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	for (const line of renderStatus.buildTabBarLines(cols)) lines.push(line)
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
	return `${renderStatus.colorText(tab.name, renderStatus.statusHighlightColor(), base)} (${tab.sessionId})`
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
	if (client.state.role === 'client') return `client:${client.state.pid} / server:${client.state.hostPid ?? '?'}${renderStatus.hostMismatchBadge()}`
	return `server:${client.state.pid}`
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
		const blank = cols > 1 ? ` ${' '.repeat(Math.max(0, cols - 2))} ` : ' '
		lines.push(`${base}${clipVisual(blank, cols)}${RESET}`)
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
	const innerWidth = Math.max(0, cols - 2)
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
			if (showServer) {
				showServer = false
				continue
			}
			if (showTokens) {
				showTokens = false
				continue
			}
			if (showPlan) {
				showPlan = false
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

	const line = cols >= 2 ? ` ${inner} ` : inner
	lines.push(`${base}${visLen(line) > cols ? clipVisual(line, cols) : line}${RESET}`)
}

function renderHelpBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const busy = client.isBusy()
	const hasText = prompt.text().trim().length > 0
	const continueAction = client.continueActionForCurrentTurn()
	const desc = colors.help.description || '\x1b[90m'
	const bar = helpBar.build(busy, hasText, continueAction, {
		key: colors.help.key || '\x1b[37m',
		description: desc,
		separator: desc,
	})
	// Always push a line — even when empty — so chrome height is constant.
	// Without this, typing the first character causes a 1-row jump.
	lines.push(bar ? `${clipVisual(bar, cols)}${RESET}` : '')
}

function renderPrompt(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const p = prompt.buildPrompt(cols)
	for (const line of p.lines) lines.push(line)
}

// How many frame lines the chrome (tab bar + status + prompt + help bar) occupies.
// Help bar always counts as 1 line (even when empty) to prevent jumps.
function chromeLines(): number {
	const cols = process.stdout.columns || 80
	return renderStatus.buildTabBarLines(cols).length + 2 + prompt.buildPrompt(cols).lines.length
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
	halCursorColor,
	tabIndicator,
	renderIndicator,
	tabDir,
	tabInner,
	tabLabel,
	wrapTabLabels,
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
}
