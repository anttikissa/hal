import { terminal } from '../src/client/terminal.ts'
import { colors, type Look } from '../src/common/colors.ts'
import type { Plugin } from '../src/host/plugins.ts'

// Blade Runner (1982): blue-black night, hot pink neon for Hal, neon
// cyan for you, amber warnings.
export const look: Look = {
	screen: [0.15, 0.035, 275],
	fgL: 0.8,
	fgC: 0.2,
	bgL: 0.21,
	bgC: 0.07,
	assistant: () => ({ fg: [0.74, 0.22, 350], cursor: [0.74, 0.22, 350], cursorIdle: [0.58, 0.08, 350], bold: [0.88, 0.13, 350], code: [0.84, 0.09, 350], linkFg: [0.84, 0.17, 350], linkBg: [0.28, 0.08, 350] }),
	user: () => ({ fg: [0.87, 0.15, 200], bg: [0.22, 0.06, 215] }),
	thinking: () => ({ fg: [0.74, 0.08, 295], bold: [0.86, 0.07, 295], code: [0.8, 0.07, 295], linkBg: [0.22, 0.05, 295] }),
	warning: () => ({ fg: [0.84, 0.17, 70], bg: [0.22, 0.06, 70], code: [0.9, 0.12, 70], linkBg: [0.3, 0.07, 70] }),
	error: () => ({ fg: [0.72, 0.22, 30], bg: [0.22, 0.08, 30], code: [0.85, 0.14, 30], linkBg: [0.25, 0.07, 30] }),
	status: (base) => ({ ...base(), highlight: [0.86, 0.15, 200] }),
	popupCurrent: () => ({ fg: [0.98, 0.04, 350], bg: [0.45, 0.16, 350] }),
	page: (base) => ({ ...base(), canvas: [0.13, 0.04, 275], text: [0.93, 0.03, 300], accent: [0.74, 0.22, 350], field: [0.18, 0.05, 275], border: [0.55, 0.14, 320], button: [0.32, 0.12, 330] }),
	tab: (base) => ({ ...base(), activeFg: [0.78, 0.2, 350] }),
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
