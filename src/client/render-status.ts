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
import { helpBar } from './terminal/help-bar.ts'
import { client } from './app.ts'
import { models } from '../common/models.ts'
import type { TokenUsage } from '../common/protocol.ts'
import { clientBackend } from './backend.ts'
import { HAL_DIR } from '../state.ts'
import { colors } from './terminal/colors.ts'
import { prompt } from './terminal/prompt.ts'
import { cursor } from './terminal/cursor.ts'
import { promptEdit } from './prompt-edit.ts'
import { completionHints } from './terminal/completion-hints.ts'
import type { Tab } from './app.ts'

const RESET = '\x1b[0m'

type TabHelpHint = { text: string; priority: number }
type TabIndicator = { char: string; color: string; blinks: boolean }

const config = {
	showSession: true,
	showCwd: true,
	showModel: true,
	showContext: true,
	showServer: true,
	showTokenInOut: true,
	showTokenCache: false,
	showSubscription: true,
	promptCursorShape: 'block',
}

function halCursorColor(): string {
	return colors.assistant.cursor ?? colors.assistant.fg
}

function inputStyle(): string {
	return `${colors.user.bg || colors.input.bg}${colors.user.fg || colors.info.fg}`
}

function cursorShapeSequence(shape = renderStatus.config.promptCursorShape): string {
	if (shape === 'native') return ''
	if (shape === 'block') return '\x1b[2 q'
	if (shape === 'blinking-block') return '\x1b[1 q'
	if (shape === 'underline') return '\x1b[4 q'
	if (shape === 'blinking-underline') return '\x1b[3 q'
	if (shape === 'bar') return '\x1b[6 q'
	if (shape === 'blinking-bar') return '\x1b[5 q'
	return ''
}

function promptCursorColorSequence(color = colors.input.cursor || colors.user.fg): string {
	const hex = oklch.fgHex(color)
	return hex ? `\x1b]12;#${hex}\x07` : ''
}

function tabIndicator(tab: Tab): TabIndicator {
	const working = client.state.working.get(tab.sessionId) ?? false
	if (client.state.toolConfirmPending.has(tab.sessionId)) return { char: '!', color: colors.tab.warningFg || colors.warning.fg, blinks: false }

	if (working && tab.attention === 'new') return { char: '◆', color: colors.tab.warningFg || colors.warning.fg, blinks: true }
	if (working) return { char: '▪', color: renderStatus.halCursorColor(), blinks: true }
	// Alerts beat the generic "done unseen" checkmark. This matters for cases
	// like "Hit max iterations" where generation finished, but the tab still
	// needs attention.
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const b = tab.history[i]!
		// Skip trailing info blocks that aren't status-relevant.
		if ((b.type === 'log' || b.type === 'info') && b.text !== '[paused]' && b.text !== '[paused before local tools]' && !b.text?.startsWith('[interrupted]')) continue
		if (b.type === 'warning') return { char: '!', color: colors.tab.warningFg || colors.warning.fg, blinks: false }
		if (b.type === 'error') {
			if ((b as any).retryable === false) return { char: '', color: '', blinks: false }
			return { char: '✗', color: colors.tab.errorFg || colors.error.fg, blinks: true }
		}
		if (b.type === 'log' && (b.text === '[paused]' || b.text === '[paused before local tools]' || b.text?.startsWith('[interrupted]'))) {
			return { char: '!', color: colors.tab.pausedFg || colors.tab.warningFg || colors.warning.fg, blinks: false }
		}
		break
	}

	if (tab.attention === 'new') return { char: '◆', color: colors.tab.warningFg || colors.warning.fg, blinks: false }
	if (tab.doneUnseen) return { char: '✓', color: colors.tab.doneFg || colors.info.fg, blinks: false }

	return { char: '', color: '', blinks: false }
}

function hasAnimatedIndicators(): boolean {
	for (const tab of client.state.tabs) {
		if (renderStatus.tabIndicator(tab).blinks) return true
		if (client.state.summarizing.has(tab.sessionId)) return true
	}
	return false
}

function backgroundIndicatorColor(): string {
	return colors.status.fg || colors.tab.inactiveFg || colors.info.fg
}

function renderBackgroundIndicator(tab: Tab, baseColor: string): string {
	const color = renderStatus.backgroundIndicatorColor()
	if (client.state.summarizing.has(tab.sessionId)) {
		const visibleColor = cursor.isVisible() ? color : oklch.dimAnsi(color, 0.65)
		return `${visibleColor}▪${baseColor}`
	}
	if (client.state.whatDoneUnseen.has(tab.sessionId)) return `${color}✓${baseColor}`
	return ''
}

function renderIndicator(tab: Tab, baseColor: string): string {
	const ind = renderStatus.tabIndicator(tab)
	let out = ''
	if (ind.char) {
		if (!ind.blinks || cursor.isVisible()) out += `${ind.color}${ind.char}${baseColor}`
		else {
			const color = ind.color === renderStatus.halCursorColor() ? colors.input.cursorDim || ind.color : oklch.dimAnsi(ind.color, 0.65)
			out += `${color}${ind.char}${baseColor}`
		}
	}
	return out + renderStatus.renderBackgroundIndicator(tab, baseColor)
}

function tabInner(num: number, ind: string): string {
	return `${num}${ind}`
}

function tabLabel(tab: Tab, i: number): string {
	const focusedIndex = client.state.focusedTabIndex
	const base = i === focusedIndex ? colors.tab.activeFg || colors.status.highlight : colors.tab.inactiveFg || colors.status.fg
	const ind = renderStatus.renderIndicator(tab, base)
	const content = renderStatus.tabInner(i + 1, ind)
	if (i === focusedIndex) return `${base}[${content}]${RESET}`
	return `${base} ${content} ${RESET}`
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
	return colors.status.fg || colors.tab.inactiveFg
}

function statusHighlightColor(): string {
	return colors.status.highlight || colors.tab.activeFg
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
	if (client.state.localVersionStatus !== 'ready') return ''
	if (!client.state.hostVersion || !client.state.localVersion) return ''
	return client.state.hostVersion === client.state.localVersion ? '' : ' ≠host'
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
	const current = clientBackend.subscriptions.current(provider)
	if (!current) return ''
	const windows: string[] = []
	for (const item of current.windows) {
		const pct = Math.round(item.usedPercent)
		windows.push(`${item.label} ${renderStatus.heatText(`${pct}%`, pct, base)}`)
	}
	// Show the slot as index/total when multiple subscription accounts exist.
	const slot = current.index != null && current.total && current.total > 1 ? ` ${current.index + 1}/${current.total}` : ''
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
	const isSub = !clientBackend.subscriptions.isApiKey(provider)
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
	const working = client.isWorking()
	const hasText = prompt.text().trim().length > 0
	const continueAction = client.continueActionForCurrentTurn()
	const desc = colors.help.description || colors.status.fg
	const style = {
		key: colors.help.key || colors.status.highlight,
		description: desc,
		separator: desc,
	}
	const editHint = promptEdit.hint(client.currentTab()?.sessionId)
	if (editHint) {
		const warning = colors.warning.fg || colors.help.description || colors.status.fg
		lines.push(`${renderStatus.paddedLine(`${warning}${editHint}`, cols)}${RESET}`)
		return
	}
	const completionText = completionHints.text(renderStatus.contentWidth(cols))
	if (completionText) {
		const styledCompletion = `${desc}${completionText}`
		lines.push(`${renderStatus.paddedLine(styledCompletion, cols)}${RESET}`)
		return
	}
	const baseLeft = helpBar.build(working, hasText, continueAction, style)
	const restoreText = client.state.restoreTabHint ? helpBar.restoreTabHint(style) : ''
	const resizeHint = prompt.resizeHint(cols)
	const resizeText = resizeHint ? `${style.key}ctrl-=/-${style.description}: ${resizeHint}` : ''
	const separator = `${style.separator}, `
	const left = [restoreText, resizeText, baseLeft].filter(Boolean).join(separator)
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

function promptEditActivityStatusLabel(tab: Tab): string {
	const active = promptEdit.activeFor(tab.sessionId)
	if (!active) return ''

	let label = 'editing previous prompt copy'
	if (active.mode === 'amend' || active.mode === 'cancel') label = 'editing current prompt'
	if (!active.pausedWorkingTurn) return label

	const phase = client.state.working.get(tab.sessionId) ? 'pausing' : 'paused'
	return `${label} · ${phase}`
}

function turnActivityStatusLabel(tab: Tab): string {
	const editStatus = renderStatus.promptEditActivityStatusLabel(tab)
	if (editStatus) return editStatus
	if (client.state.toolConfirmPending.has(tab.sessionId)) return 'waiting for approval'
	if (!client.state.working.get(tab.sessionId)) {
		if (client.continueActionForTab(tab) === 'continue') return 'paused'
		return ''
	}

	let runningTools = 0
	let runningToolName = ''
	for (const block of tab.history) {
		if (block.type === 'tool' && block.running) {
			runningTools++
			runningToolName = block.name
		}
	}
	if (runningTools > 1) return `running ${runningTools} tools`
	if (runningTools === 1) return `running ${runningToolName}`

	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]!
		if (block.type === 'assistant' && block.streaming) return 'writing'
		if (block.type === 'thinking' && block.streaming) return 'thinking'
		if (block.type === 'info') {
			const match = block.text.match(/retrying in (\S+)/i)
			if (match) return `retrying in ${match[1]}`
		}
	}
	// The final stream event precedes the working=false IPC update. Avoid briefly
	// relabeling a completed response as processing during that cleanup gap.
	const lastBlock = tab.history.at(-1)
	if (lastBlock?.type === 'assistant' && !lastBlock.streaming) return ''

	return 'processing'
}

function activityStatusLabel(tab = client.currentTab()): string {
	if (!tab) return ''
	return [
		renderStatus.turnActivityStatusLabel(tab),
		client.state.summarizing.has(tab.sessionId) ? 'summarizing' : '',
	].filter(Boolean).join(' · ')
}

function ruleText(cols: number, left = '', center = ''): string {
	const leftText = left ? ` ${left} ` : ''
	const centerText = center ? ` ${center} ` : ''
	if (!centerText) {
		const clippedLeft = visLen(leftText) > cols ? clipVisual(leftText, cols) : leftText
		return `${clippedLeft}${'─'.repeat(Math.max(0, cols - visLen(clippedLeft)))}`
	}

	const clippedCenter = visLen(centerText) > cols ? clipVisual(centerText, cols) : centerText
	const centerWidth = visLen(clippedCenter)
	let clippedLeft = leftText
	if (visLen(clippedLeft) + centerWidth > cols) clippedLeft = clipVisual(clippedLeft, Math.max(0, cols - centerWidth))

	const leftWidth = visLen(clippedLeft)
	let centerStart = Math.floor(Math.max(0, cols - centerWidth) / 2)
	if (centerStart < leftWidth) centerStart = leftWidth
	if (centerStart + centerWidth > cols) centerStart = Math.max(0, cols - centerWidth)

	const beforeCenter = Math.max(0, centerStart - leftWidth)
	const afterCenter = Math.max(0, cols - leftWidth - beforeCenter - centerWidth)
	return `${clippedLeft}${'─'.repeat(beforeCenter)}${clippedCenter}${'─'.repeat(afterCenter)}`
}

function promptRule(cols: number, indicator = '', status = ''): string {
	return `${renderStatus.inputStyle()}${renderStatus.ruleText(cols, indicator, status)}${RESET}`
}

function paddedPromptLine(line: string, cols: number): string {
	return `${renderStatus.inputStyle()}${renderStatus.paddedLine(line, cols)}${RESET}`
}

function renderPrompt(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const p = prompt.buildPrompt(renderStatus.promptContentWidth(cols))
	const above = p.fold.above > 0 ? `↑${p.fold.above}` : ''
	const below = p.fold.below > 0 ? `↓${p.fold.below}` : ''
	lines.push(renderStatus.promptRule(cols, above, renderStatus.activityStatusLabel()))
	for (const line of p.lines) lines.push(renderStatus.paddedPromptLine(line, cols))
	lines.push(renderStatus.promptRule(cols, below))
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
	cursorShapeSequence,
	promptCursorColorSequence,
	tabIndicator,
	renderIndicator,
	backgroundIndicatorColor,
	renderBackgroundIndicator,
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
	turnActivityStatusLabel,
	promptEditActivityStatusLabel,
	activityStatusLabel,
	ruleText,
	promptRule,
	paddedPromptLine,
}
