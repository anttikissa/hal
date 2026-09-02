// Terminal rendering for semantic subscription usage bars.

import { oklch } from '../../utils/oklch.ts'
import { colors } from './colors.ts'

const BAR_PARTIALS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇']
const BAR_FILL_FG = oklch.toAnsi(38, 0.84, 0, 0)

function usageBar(totalEighths: number, width: number): string {
	const clampedEighths = Math.max(0, Math.min(width * 8, totalEighths))
	const full = Math.floor(clampedEighths / 8)
	const partial = clampedEighths % 8
	const fill = `${'█'.repeat(full)}${BAR_PARTIALS[partial] ?? ''}`

	return `${BAR_FILL_FG}${fill}${colors.log.fg}${colors.log.bg}`
}

export const terminalSubscriptionUsage = { usageBar }
