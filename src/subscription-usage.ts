// Shared helpers and config for OAuth subscription usage displays.

import { colors } from './client/terminal/colors.ts'
import { oklch } from './utils/oklch.ts'

const BAR_PARTIALS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇']
const BAR_FILL_FG = oklch.toFg(0.84, 0, 0)
const BAR_EMPTY_BG = oklch.toBg(0.36, 0, 0)

const config = {
	censorEmails: false,
}

function usageBar(usedPercent: number, configuredWidth: number): string {
	const width = Math.max(1, Math.round(configuredWidth))
	const clamped = Math.max(0, Math.min(100, usedPercent))
	const totalEighths = Math.round((clamped / 100) * width * 8)
	const full = Math.floor(totalEighths / 8)
	const partial = totalEighths % 8
	const empty = width - full - (partial > 0 ? 1 : 0)
	const fill = `${'█'.repeat(full)}${BAR_PARTIALS[partial] ?? ''}`

	// Set the empty background first, so the partial glyph uses that same
	// background as the empty part of the bar.
	return `${BAR_EMPTY_BG}${BAR_FILL_FG}${fill}${BAR_EMPTY_BG}${' '.repeat(Math.max(0, empty))}${colors.log.fg}${colors.log.bg}`
}

function usageBarAnsiSequences(): string[] {
	return [BAR_FILL_FG, BAR_EMPTY_BG, colors.log.fg, colors.log.bg].filter(Boolean)
}

function maskLabel(label: string, stars: number): string {
	if (!label) return ''
	// Status output goes through the markdown table renderer, so the masking stars
	// must be escaped to stay literal instead of turning nearby text italic.
	return `${label[0]}${'\\*'.repeat(stars)}`
}

function censorEmail(email: string): string {
	const at = email.indexOf('@')
	if (at === -1) return email
	const local = email.slice(0, at)
	const domain = email.slice(at + 1)
	const dot = domain.indexOf('.')
	if (dot === -1) return email
	const domainLabel = domain.slice(0, dot)
	const suffix = domain.slice(dot + 1)
	const maskedDomain = maskLabel(domainLabel, domainLabel.length <= 5 ? 4 : 3)
	return `${maskLabel(local, 3)}@${maskedDomain}.${suffix}`
}

export const subscriptionUsage = { config, usageBar, usageBarAnsiSequences, censorEmail }
