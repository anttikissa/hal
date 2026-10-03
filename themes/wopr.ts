import { terminal } from '../src/client/terminal.ts'
import { colors, type Look } from '../src/common/colors.ts'
import type { Plugin } from '../src/host/plugins.ts'

// WarGames (1983): one green phosphor in several brightnesses on
// black, like a VT100. Only errors get another colour.
const green = (l: number, c = 0.18): [number, number, number] => [l, c, 145]
const tool = () => ({ fg: green(colors.fgL, colors.fgC), bg: green(colors.bgL, colors.bgC) })

export const look: Look = {
	screen: [0.1, 0.01, 145],
	fgL: 0.85,
	fgC: 0.19,
	bgL: 0.15,
	bgC: 0.04,
	assistant: () => ({ fg: green(0.86), cursor: green(0.86), cursorIdle: green(0.6, 0.08), bold: green(0.95, 0.14), code: green(0.9, 0.12), linkFg: green(0.93, 0.16), linkBg: green(0.24, 0.06) }),
	thinking: () => ({ fg: green(0.72, 0.1), bold: green(0.84, 0.1), code: green(0.78, 0.1), linkBg: green(0.18, 0.04) }),
	user: () => ({ fg: green(0.95, 0.12), bg: green(0.19, 0.06) }),
	log: () => ({ fg: green(0.7, 0.08), code: green(0.78, 0.08), linkBg: green(0.26, 0.05) }),
	warning: () => ({ fg: green(0.97, 0.1), bg: green(0.22, 0.07), code: green(0.98, 0.06), linkBg: green(0.3, 0.07) }),
	error: () => ({ fg: [0.7, 0.22, 28], bg: [0.17, 0.06, 28], code: [0.84, 0.14, 28], linkBg: [0.26, 0.07, 28] }),
	info: () => ({ fg: green(0.78, 0.1), bg: green(0.14, 0.03), code: green(0.86, 0.08), linkBg: green(0.26, 0.05) }),
	fork: () => ({ fg: green(0.88, 0.16), bg: green(0.18, 0.05) }),
	status: () => ({ fg: green(0.7, 0.08), highlight: green(0.94, 0.14) }),
	statusCool: () => ({ fg: green(0.8, 0.16) }),
	statusWarm: () => ({ fg: green(0.95, 0.1) }),
	statusHot: () => ({ fg: colors.error().fg! }),
	tab: () => ({ activeFg: green(0.95, 0.16), inactiveFg: green(0.66, 0.08), doneFg: green(0.82, 0.18), warningFg: green(0.97, 0.1), errorFg: colors.error().fg!, pausedFg: green(0.97, 0.1) }),
	help: () => ({ key: green(0.86, 0.14), description: green(0.66, 0.08) }),
	popup: () => ({ neutralFg: green(0.7, 0.08), dangerFg: colors.error().fg! }),
	popupCurrent: () => ({ fg: green(0.98, 0.06), bg: green(0.4, 0.12) }),
	popupMatch: () => ({ fg: green(0.97, 0.12) }),
	popupModelCurrent: () => ({ fg: green(0.9, 0.1), bg: green(0.24, 0.05) }),
	page: () => ({ canvas: green(0.09, 0.01), text: green(0.88, 0.17), accent: green(0.9, 0.2), field: green(0.13, 0.03), border: green(0.5, 0.12), button: green(0.28, 0.08), match: green(0.97, 0.12) }),
	tool,
	toolBash: tool,
	toolEval: tool,
	toolRead: tool,
	toolWrite: tool,
	toolEdit: tool,
}

// A theme is a plugin (task d3): /theme links it to plugins/color-theme.ts.
export default (plugin: Plugin) => {
	for (let [key, v] of Object.entries(look)) {
		if (typeof v === 'function') plugin.around(colors, key as never, v as never)
		else plugin.set(colors, key as never, v as never)
	}
	plugin.onChange(() => terminal.redraw())
}
