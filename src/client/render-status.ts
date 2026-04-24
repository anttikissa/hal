// Status/chrome rendering helpers extracted from render.ts.
//
// This module owns only presentation logic for the tab bar, status line,
// help bar, and prompt. Diff/fullscreen/cursor state still lives in render.ts.

import { visLen, clipVisual } from '../utils/strings.ts'
import { oklch } from '../utils/oklch.ts'
import { helpBar } from '../cli/help-bar.ts'
import { client } from '../client.ts'
import { models } from '../models.ts'
import type { TokenUsage } from '../protocol.ts'
import { auth } from '../auth.ts'
import { openaiUsage } from '../openai-usage.ts'
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
const INPUT_CURSOR_COLOR = '\x1b[38;5;75m' // matches prompt cursor color

function tabIndicator(tab: Tab): { char: string; color: string; blinks: boolean } {
	const busy = client.state.busy.get(tab.sessionId) ?? false

	if (busy) return { char: '▪', color: INPUT_CURSOR_COLOR, blinks: true }

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
		if (tabIndicator(tab).blinks) return true
	}
	return false
}

// Render the 1-char indicator. Animated indicators pulse between bright and dim
// phases instead of disappearing, so a busy tab never looks idle.
function renderIndicator(tab: Tab, baseColor: string): string {
	const ind = tabIndicator(tab)
	if (!ind.char) return ''
	if (!ind.blinks || cursor.isVisible()) return `${ind.color}${ind.char}${baseColor}`
	return `${ANSI_DIM}${ind.color}${ind.char}${RESET}${baseColor}`
}

// Tab bar: prefers [n dir name], then [n name], then just numbers.
// Each tab shows a 1-char status indicator between the number and title.
function renderTabBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const tabs = client.state.tabs
	const active = client.state.activeTab

	function tabDir(tab: Tab): string {
		return tab.cwd.split('/').filter(Boolean).pop() ?? ''
	}

	function inner(num: number, ind: string, text?: string): string {
		if (text) return `${num}${ind || ' '}${text}`
		return `${num}${ind}`
	}

	function label(tab: Tab, i: number, mode: 'wide' | 'name' | 'num'): string {
		const ind = renderIndicator(tab, i === active ? BRIGHT_WHITE : DIM)
		const name = tab.name || tab.sessionId
		const dir = tabDir(tab)
		const text = mode === 'wide'
			? (dir && dir !== name ? `${dir} ${name}` : name)
			: mode === 'name'
				? name
				: ''
		const content = inner(i + 1, ind, text)
		if (i === active) return `${BRIGHT_WHITE}[${content}]${RESET}`
		return `${DIM} ${content} ${RESET}`
	}

	for (const mode of ['wide', 'name', 'num'] as const) {
		const rendered = tabs.map((tab, i) => label(tab, i, mode))
		const joined = rendered.join('')
		if (visLen(joined) <= cols) {
			lines.push(joined)
			return
		}
	}

	const terse = tabs.map((tab, i) => label(tab, i, 'num'))
	lines.push(clipVisual(terse.join(''), cols))
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
	return colorText(text, oklch.usageFg(pct), base)
}

function hasCustomSessionName(tab: Tab): boolean {
	return !!tab.name && tab.name !== tab.sessionId && !/^tab \d+$/i.test(tab.name)
}

function currentHalDir(): string {
	return process.env.HAL_DIR ?? HAL_DIR
}

function sessionStatusLabel(tab: Tab, base: string): string {
	if (!hasCustomSessionName(tab)) return tab.sessionId
	return `${colorText(tab.name, statusHighlightColor(), base)} (${tab.sessionId})`
}

function cwdStatusLabel(tab: Tab, base: string): string {
	const cwd = shortenPath(tab.cwd)
	if (!cwd) return ''
	const color = tab.cwd === currentHalDir() ? colors.assistant.fg : statusHighlightColor()
	return colorText(cwd, color, base)
}

function modelStatusLabel(modelId: string, base: string): string {
	const display = models.displayModel(modelId)
	if (!display) return ''
	return colorText(display, statusHighlightColor(), base)
}

function contextStatusLabel(tab: Tab, base: string): string {
	if (tab.contextMax <= 0) return ''
	const pct = Math.round((tab.contextUsed / tab.contextMax) * 100)
	const used = heatText(models.formatTokenCount(tab.contextUsed), pct, base)
	const max = models.formatTokenCount(tab.contextMax)
	const percent = heatText(`${pct}%`, pct, base)
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
	if (client.state.role === 'client') return `client:${client.state.pid} / server:${client.state.hostPid ?? '?'}${hostMismatchBadge()}`
	return `server:${client.state.pid}`
}

function formatTotalTokens(total: number): string {
	if (total >= 1_000_000) {
		const millions = total / 1_000_000
		return `${millions.toFixed(millions >= 10 ? 0 : 1)}M`
	}
	return models.formatTokenCount(total)
}

function tokenUsageLabel(
	usage: TokenUsage,
	long = false,
): string {
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation
	if (total <= 0) return ''
	// Show cache hit rate when cacheRead is a meaningful fraction of total input tokens processed.
	const totalInput = usage.input + usage.cacheRead + usage.cacheCreation
	const hitRate = totalInput > 0 ? Math.round((usage.cacheRead / totalInput) * 100) : 0
	const cacheHint = hitRate >= 5 ? ` CR:${hitRate}%` : ''
	return `${formatTotalTokens(total)} ${long ? 'tokens' : 'tok'}${cacheHint}`
}

function subscriptionStatusLabel(base: string): string {
	const current = openaiUsage.current()
	if (!current) return ''
	const windows: string[] = []
	if (current.primary) {
		const pct = Math.round(current.primary.usedPercent)
		windows.push(`5h ${heatText(`${pct}%`, pct, base)}`)
	}
	if (current.secondary) {
		const pct = Math.round(current.secondary.usedPercent)
		windows.push(`7d ${heatText(`${pct}%`, pct, base)}`)
	}
	const slot = current.index != null && current.total ? ` ${current.index + 1}/${current.total}` : ''
	if (windows.length === 0) return `Sub${slot}`
	return `Sub${slot}: ${windows.join(', ')}`
}

function renderStatusLine(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const base = statusBaseColor()
	const tab = client.currentTab()
	if (!tab) {
		const blank = cols > 1 ? ` ${' '.repeat(Math.max(0, cols - 2))} ` : ' '
		lines.push(`${base}${clipVisual(blank, cols)}${RESET}`)
		return
	}

	const modelId = tab.model || models.defaultModel()
	const provider = models.providerName(modelId)
	const isSub = !auth.isApiKey(provider)
	const left = joinStatusParts([
		sessionStatusLabel(tab, base),
		cwdStatusLabel(tab, base),
		modelStatusLabel(modelId, base),
		contextStatusLabel(tab, base),
	])

	const server = serverStatusLabel()
	const tokenShort = tokenUsageLabel(tab.usage, false)
	const tokenLong = tokenUsageLabel(tab.usage, true)
	const plan = provider === 'openai' && isSub ? subscriptionStatusLabel(base) : ''
	const innerWidth = Math.max(0, cols - 2)
	let showServer = !!server
	let showTokens = !!tokenShort
	let showPlan = !!plan
	let inner = ''

	while (true) {
		const shortRight = joinStatusParts([
			showServer ? server : '',
			showTokens ? tokenShort : '',
			showPlan ? plan : '',
		])
		const longRight = joinStatusParts([
			showServer ? server : '',
			showTokens ? tokenLong : '',
			showPlan ? plan : '',
		])
		const right = showTokens && tokenLong && innerWidth - visLen(left) - visLen(longRight) >= 10 ? longRight : shortRight
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

// How many frame lines the chrome (tab bar + status + help bar + prompt) occupies.
// Help bar always counts as 1 line (even when empty) to prevent jumps.
function chromeLines(): number {
	const cols = process.stdout.columns || 80
	return 3 + prompt.buildPrompt(cols).lines.length // tab bar + status + help bar + prompt
}

export const renderStatus = { chromeLines, hasAnimatedIndicators, renderTabBar, renderStatusLine, renderHelpBar, renderPrompt }
