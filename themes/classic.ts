import { terminal } from '../src/client/terminal.ts'
import { colors, type Look } from '../src/common/colors.ts'
import type { Plugin } from '../src/host/plugins.ts'

// Classic: Hal's built-in look before Nostromo's became it. Orange
// replies, a bright blue user card, a blue-gray screen.
export const look: Look = {
	screen: [0.16, 0.01, 260],
	fgL: 0.85,
	fgC: 0.16,
	assistant: () => ({ fg: [colors.fgL, colors.fgC, 57], cursor: [colors.fgL, colors.fgC, 55], cursorIdle: [0.6, 0, 55], bold: [0.9, 0.06, 55], code: [0.86, 0.04, 55], linkFg: [0.88, 0.15, 55], linkBg: [0.3, 0.05, 55] }),
	user: () => ({ fg: [0.86, 0.16, 215], bg: [0.21, 0.06, 215] }),
	warning: () => ({ fg: [0.87, 0.18, 82], bg: [0.2, 0.05, 82], code: [0.92, 0.12, 82], linkBg: [0.28, 0.06, 82] }),
	error: () => ({ fg: [0.72, 0.24, 25], bg: [0.2, 0.08, 25], code: [0.84, 0.16, 25], linkBg: [0.24, 0.07, 25] }),
	page: (base) => ({ ...base(), canvas: [0.14, 0.01, 260], text: [0.93, 0.01, 260], accent: [0.86, 0.16, 200], field: [0.18, 0.015, 260], border: [0.5, 0.08, 210], button: [0.3, 0.08, 215] }),
	tab: (base) => ({ ...base(), activeFg: [0.86, 0.16, 200] }),
}

// A theme is a plugin (tasks d3, 4c1): /theme selects it in plugins/theme.ts.
export default (plugin: Plugin) => {
	for (let [key, v] of Object.entries(look)) {
		if (typeof v === 'function') plugin.around(colors, key as never, v as never)
		else plugin.set(colors, key as never, v as never)
	}
	// Repaint in these colors now, and in the remaining ones once removed.
	terminal.redraw()
	return () => terminal.redraw()
}
