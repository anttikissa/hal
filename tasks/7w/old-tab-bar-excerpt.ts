function tabIndicator(tab: Tab): TabIndicator {
	const working = client.state.working.get(tab.sessionId) ?? false

	if (renderStatus.activeQuestion(tab)) return { char: '!', color: colors.tab.warningFg || colors.warning.fg, blinks: false }
	if (working && tab.attention === 'new') return { char: '◆', color: colors.tab.warningFg || colors.warning.fg, blinks: true }
	if (working) return { char: '▪', color: renderStatus.halCursorColor(), blinks: true }
	// Explicit warnings beat turn status, but retry/continue comes only from the
	// server's authoritative history projection.
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const block = tab.history[i]!
		if (block.type === 'warning') return { char: '!', color: colors.tab.warningFg || colors.warning.fg, blinks: false }
		if (block.type !== 'log' && block.type !== 'info') break
	}
	const action = client.continueActionForTab(tab)
	if (action === 'retry') return { char: '✗', color: colors.tab.errorFg || colors.error.fg, blinks: true }
	if (action === 'continue') return { char: '!', color: colors.tab.pausedFg || colors.tab.warningFg || colors.warning.fg, blinks: false }

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

// A blink has to survive terminals that cannot vary color: when the dim and
// lit colors would render identically, drop the glyph instead so the blink
// stays visible as presence/absence.
function blinkGlyph(char: string, litColor: string, dimColor: string, baseColor: string): string {
	if (cursor.isVisible()) return `${litColor}${char}${baseColor}`
	if (dimColor !== litColor) return `${dimColor}${char}${baseColor}`
	return ' '.repeat(visLen(char))
}

function renderBackgroundIndicator(tab: Tab, baseColor: string): string {
	const color = renderStatus.backgroundIndicatorColor()
	if (client.state.summarizing.has(tab.sessionId)) {
		return renderStatus.blinkGlyph('▪', color, oklch.dimAnsi(color, 0.65), baseColor)
	}
	if (client.state.whatDoneUnseen.has(tab.sessionId)) return `${color}✓${baseColor}`
	return ''
}

function renderIndicator(tab: Tab, baseColor: string): string {
	const ind = renderStatus.tabIndicator(tab)
	let out = ''
	if (ind.char) {
		if (!ind.blinks) out += `${ind.color}${ind.char}${baseColor}`
		else {
			const dim = ind.color === renderStatus.halCursorColor() ? colors.input.cursorDim || ind.color : oklch.dimAnsi(ind.color, 0.65)
			out += renderStatus.blinkGlyph(ind.char, ind.color, dim, baseColor)
		}
	}
	return out + renderStatus.renderBackgroundIndicator(tab, baseColor)
}

function tabInner(num: number, ind: string): string {
	return `${num}${ind}`
}

function tabLabel(tab: Tab, i: number, compact = false): string {
	const focusedIndex = client.state.focusedTabIndex
	const isActive = i === focusedIndex
	const base = isActive ? colors.tab.activeFg || colors.status.highlight : colors.tab.inactiveFg || colors.status.fg
	const ind = renderStatus.renderIndicator(tab, base)
	const content = blockText.hyperlink(renderStatus.tabInner(i + 1, ind), webLinks.url(tab.sessionId))
	if (!compact) {
		if (isActive) return `${base}[${content}]${RESET}`
		return `${base} ${content} ${RESET}`
	}
	// Compact mode halves the padding: buildTabText puts a single space between
	// labels instead of the two spaces this padding produces, and the active tab
	// gets an underline instead of brackets, which would cost the width we save.
	if (isActive) return `${base}\x1b[4m${content}\x1b[24m${RESET}`
	return `${base}${content}${RESET}`
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

function buildTabText(compact = false): string {
	let text = ''
	for (let i = 0; i < client.state.tabs.length; i++) {
		// Compact labels carry no padding of their own, so separate them here.
		if (compact && i > 0) text += ' '
		text += renderStatus.tabLabel(client.state.tabs[i]!, i, compact)
	}
	return text
}

function buildTabBarLines(cols: number): string[] {
	const width = renderStatus.contentWidth(cols)
	const tabText = renderStatus.buildTabText()
	let content = tabText + renderStatus.fitTabHelpText(client.state.tabs.length, tabText, cols)
	// Even the bare tab numbers (no help hints) don't fit:
	// switch to compact mode, which drops the space padding between tabs and
	// underlines the active tab instead of bracketing it, rather than
	// clipping tabs off the end.
	if (visLen(tabText) > width) {
		content = renderStatus.buildTabText(true)
	}
	// `paddedLine()` may clip through a compact active tab's underline-on escape.
	// Terminate the row explicitly so that style cannot affect the prompt below it.
	return [`${renderStatus.paddedLine(content, cols)}${RESET}`]
}

// Appends one full-width logical row, without a newline. For example, at 12
// columns with padding enabled: [] → [" Tabs: [1]  "] (ANSI omitted).
function renderTabBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	if (renderStatus.config.tabsOpacity <= 0) {
		lines.push(renderStatus.paddedLine('', cols))
		return
	}
	lines.push(renderStatus.buildTabBarLines(cols)[0] ?? '')
}

// Shorten a path for display: replace $HOME with ~, then abbreviate.
function shortenPath(p: string): string {
	if (!p) return ''
