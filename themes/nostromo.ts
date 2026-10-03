import { terminal } from '../src/client/terminal.ts'
import { colors, type Look } from '../src/common/colors.ts'
import type { Plugin } from '../src/host/plugins.ts'

// Alien (1979): amber text, green phosphor for you, brown-black screen.
export const look: Look = {
	screen: [0.15, 0.015, 85],
	fgL: 0.84,
	fgC: 0.17,
	bgL: 0.2,
	bgC: 0.05,
	assistant: () => ({ fg: [0.84, 0.16, 75], cursor: [0.84, 0.16, 75], cursorIdle: [0.6, 0.04, 75], bold: [0.93, 0.12, 80], code: [0.88, 0.1, 80], linkFg: [0.9, 0.17, 80], linkBg: [0.28, 0.06, 75] }),
	user: () => ({ fg: [0.87, 0.2, 145], bg: [0.2, 0.05, 145] }),
	thinking: () => ({ fg: [0.74, 0.08, 85], bold: [0.86, 0.08, 85], code: [0.8, 0.08, 85], linkBg: [0.2, 0.03, 85] }),
	warning: () => ({ fg: [0.9, 0.17, 100], bg: [0.21, 0.05, 100], code: [0.94, 0.12, 100], linkBg: [0.28, 0.06, 100] }),
	error: () => ({ fg: [0.7, 0.22, 30], bg: [0.2, 0.08, 30], code: [0.82, 0.15, 30], linkBg: [0.25, 0.07, 30] }),
	page: (base) => ({ ...base(), canvas: [0.13, 0.015, 85], text: [0.88, 0.12, 85], accent: [0.86, 0.2, 145], field: [0.17, 0.02, 85], border: [0.5, 0.07, 85], button: [0.25, 0.04, 85] }),
	tab: (base) => ({ ...base(), activeFg: [0.87, 0.2, 145] }),
}

// A theme is a plugin (task d3): /theme links it to plugins/color-theme.ts.
export default (plugin: Plugin) => {
	for (let [key, v] of Object.entries(look)) {
		if (typeof v === 'function') plugin.around(colors, key as never, v as never)
		else plugin.set(colors, key as never, v as never)
	}
	plugin.onChange(() => terminal.redraw())
}
