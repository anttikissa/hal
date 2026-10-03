import { terminal } from '../src/client/terminal.ts'
import { colors, type Look } from '../src/common/colors.ts'
import type { Plugin } from '../src/host/plugins.ts'

// Tron (1982): cyan light lines on black, orange for Hal (the other
// side of the grid), cards barely tinted: lines on black.
export const look: Look = {
	screen: [0.12, 0, 0],
	fgL: 0.85,
	fgC: 0.17,
	bgL: 0.14,
	bgC: 0.025,
	assistant: () => ({ fg: [0.78, 0.19, 50], cursor: [0.78, 0.19, 50], cursorIdle: [0.6, 0.06, 50], bold: [0.9, 0.12, 55], code: [0.86, 0.09, 55], linkFg: [0.88, 0.16, 55], linkBg: [0.24, 0.06, 50] }),
	user: () => ({ fg: [0.9, 0.15, 200], bg: [0.14, 0.03, 200] }),
	thinking: () => ({ fg: [0.74, 0.07, 210], bold: [0.86, 0.07, 210], code: [0.8, 0.07, 210], linkBg: [0.2, 0.03, 210] }),
	warning: () => ({ fg: [0.9, 0.17, 95], bg: [0.14, 0.03, 95], code: [0.94, 0.1, 95], linkBg: [0.24, 0.05, 95] }),
	error: () => ({ fg: [0.7, 0.24, 25], bg: [0.15, 0.05, 25], code: [0.84, 0.15, 25], linkBg: [0.22, 0.06, 25] }),
	// Tools stay in the grid's blues and cyans.
	tool: () => ({ fg: [colors.fgL, colors.fgC, 235], bg: [colors.bgL, colors.bgC, 235] }),
	toolBash: () => ({ fg: [colors.fgL, colors.fgC, 195], bg: [colors.bgL, colors.bgC, 195] }),
	toolEval: () => ({ fg: [colors.fgL, colors.fgC, 265], bg: [colors.bgL, colors.bgC, 265] }),
	toolRead: () => ({ fg: [colors.fgL, colors.fgC, 175], bg: [colors.bgL, colors.bgC, 175] }),
	status: (base) => ({ ...base(), highlight: [0.9, 0.15, 200] }),
	help: (base) => ({ ...base(), key: [0.84, 0.1, 200] }),
	page: (base) => ({ ...base(), canvas: [0.1, 0, 0], text: [0.94, 0.03, 200], accent: [0.88, 0.15, 200], field: [0.14, 0.02, 210], border: [0.62, 0.13, 205], button: [0.28, 0.08, 210] }),
	tab: (base) => ({ ...base(), activeFg: [0.9, 0.15, 200] }),
}

// A theme is a plugin (task d3): /theme links it to plugins/color-theme.ts.
export default (plugin: Plugin) => {
	for (let [key, v] of Object.entries(look)) {
		if (typeof v === 'function') plugin.around(colors, key as never, v as never)
		else plugin.set(colors, key as never, v as never)
	}
	plugin.onChange(() => terminal.redraw())
}
