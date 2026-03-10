// Tab line rendering with busy indicators and color.

const BRIGHT_WHITE = '\x1b[97m'
const DIM = '\x1b[38;5;245m'
const RESET = '\x1b[0m'
const MAX_TITLE = 12

export interface TablineTab {
	label: string
	busy: boolean
	active: boolean
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	if (max <= 1) return '…'
	return s.slice(0, max - 1) + '…'
}

/** Extract number prefix from label like "1 .hal" → "1" */
function tabNumber(label: string): string {
	const m = label.match(/^(\d+)\s/)
	return m ? m[1] : ''
}

/** Extract title from label like "1 .hal" → ".hal" */
function tabTitle(label: string): string {
	const m = label.match(/^\d+\s+(.+)$/)
	return m ? m[1] : label.trim()
}

// ── Rendering modes (progressive degradation) ──

/** Mode 0: Full titles, max 12 chars. `[1▪.hal]` / ` 2▪.hal ` */
function mode0(tabs: TablineTab[], busyChar: string, maxTitle: number): string[] {
	return tabs.map(t => {
		const num = tabNumber(t.label)
		const title = truncate(tabTitle(t.label), maxTitle)
		const busy = t.busy ? busyChar : ' '
		if (t.active) return `${BRIGHT_WHITE}[${num}${busy}${title}]${RESET}`
		return `${DIM} ${num}${busy}${title} ${RESET}`
	})
}

/** Mode 1: Short titles (4 chars). `[1▪.hal]` / ` 2▪.hal ` */
function mode1(tabs: TablineTab[], busyChar: string): string[] {
	return mode0(tabs, busyChar, 4)
}

/** Mode 2: Numbers + busy only. `[1▪]` / ` 2  ` */
function mode2(tabs: TablineTab[], busyChar: string): string[] {
	return tabs.map(t => {
		const num = tabNumber(t.label)
		const busy = t.busy ? busyChar : ' '
		if (t.active) return `${BRIGHT_WHITE}[${num}${busy}]${RESET}`
		return `${DIM} ${num}${busy} ${RESET}`
	})
}

/** Mode 3: Just numbers. `1 2 3 4` */
function mode3(tabs: TablineTab[]): string[] {
	return tabs.map(t => {
		const num = tabNumber(t.label) || '?'
		if (t.active) return `${BRIGHT_WHITE}[${num}]${RESET}`
		return `${DIM} ${num} ${RESET}`
	})
}

/** Visible width of a string (ignoring ANSI escape sequences). */
function plainLen(s: string): number {
	return s.replace(/\x1b\[[^m]*m/g, '').length
}

function totalLen(parts: string[]): number {
	return parts.reduce((sum, p) => sum + plainLen(p), 0)
}

export function renderTabline(tabs: TablineTab[], width: number, busyVisible = true): string {
	if (width <= 0 || tabs.length === 0) return ''
	const leftPad = ' '
	const innerWidth = Math.max(0, width - plainLen(leftPad))
	if (innerWidth <= 0) return leftPad.slice(0, width)
	const busyChar = busyVisible ? '▪' : ' '

	const m0 = mode0(tabs, busyChar, MAX_TITLE)
	if (totalLen(m0) <= innerWidth) return leftPad + m0.join('')

	// Try shorter titles (8 chars)
	const m0s = mode0(tabs, busyChar, 8)
	if (totalLen(m0s) <= innerWidth) return leftPad + m0s.join('')

	const m1 = mode1(tabs, busyChar)
	if (totalLen(m1) <= innerWidth) return leftPad + m1.join('')

	const m2 = mode2(tabs, busyChar)
	if (totalLen(m2) <= innerWidth) return leftPad + m2.join('')

	const m3 = mode3(tabs)
	if (totalLen(m3) <= innerWidth) return leftPad + m3.join('')

	// Last resort: just as many numbers as fit
	let out = ''
	for (const p of m3) {
		if (plainLen(out) + plainLen(p) > innerWidth) break
		out += p
	}
	return leftPad + out
}
