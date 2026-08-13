// Terminal rendering for semantic subscription usage bars.

import { subscriptionUsage } from '../../common/subscription-usage.ts'
import { oklch } from '../../utils/oklch.ts'
import { colors } from './colors.ts'

const BAR_PARTIALS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇']
const BAR_FILL_FG = oklch.toFg(0.84, 0, 0)
const BAR_EMPTY_BG = oklch.toBg(0.36, 0, 0)

function usageBar(totalEighths: number, width: number): string {
	const clampedEighths = Math.max(0, Math.min(width * 8, totalEighths))
	const full = Math.floor(clampedEighths / 8)
	const partial = clampedEighths % 8
	const empty = width - full - (partial > 0 ? 1 : 0)
	const fill = `${'█'.repeat(full)}${BAR_PARTIALS[partial] ?? ''}`

	// Set the empty background first, so the partial glyph uses that same
	// background as the empty part of the bar.
	return `${BAR_EMPTY_BG}${BAR_FILL_FG}${fill}${BAR_EMPTY_BG}${' '.repeat(Math.max(0, empty))}${colors.log.fg}${colors.log.bg}`
}

function renderMarkers(text: string): string {
	return subscriptionUsage.replaceUsageBarMarkers(text, terminalSubscriptionUsage.usageBar)
}

export const terminalSubscriptionUsage = { usageBar, renderMarkers }
