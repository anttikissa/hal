// Terminal rendering for semantic subscription usage bars.

import { oklch } from '../../utils/oklch.ts'
import { colors } from './colors.ts'

const BAR_PARTIALS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇']
const BAR_FILL_FG = oklch.toAnsi(38, 0.84, 0, 0)
const BAR_TRACK_BG = oklch.toAnsi(48, 0.36, 0, 0)

function usageBar(totalEighths: number, width: number): string {
	const clampedEighths = Math.max(0, Math.min(width * 8, totalEighths))
	const full = Math.floor(clampedEighths / 8)
	const partial = clampedEighths % 8
	const fill = `${'█'.repeat(full)}${BAR_PARTIALS[partial] ?? ''}`
	const empty = ' '.repeat(Math.max(0, width - full - (partial > 0 ? 1 : 0)))

	return `${BAR_TRACK_BG}${BAR_FILL_FG}${fill}${BAR_TRACK_BG}${empty}${colors.log.fg}\x1b[49m`
}

export const terminalSubscriptionUsage = { usageBar }
