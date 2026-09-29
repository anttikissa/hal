// The built-in look, hal, written out as a theme (task d3): copy it to
// themes/<name>.ts, change what you like, then /theme <name>. Every
// colour is OKLCH [lightness, chroma, hue]; a style can read another
// through colors (colors.fgL()), which sees this theme's values.
// It starts equal to src/common/colors.ts; nothing keeps them in step.

import { terminal } from '../src/client/terminal.ts'
import { colors, type Look } from '../src/common/colors.ts'
import type { Plugin } from '../src/host/plugins.ts'

export const look: Look = {
	// The lightest dark background we design for: where a style has no
	// bg of its own, its text is checked against this (4.5:1, 3:1 for
	// marks; tasks/README.md, readable text).
	screen: () => [0.16, 0.01, 260],
	// Shared lightness and chroma of the vivid foregrounds and the card
	// backgrounds.
	fgL: () => 0.84,
	fgC: () => 0.19,
	bgL: () => 0.2,
	bgC: () => 0.05,

	// Hal's responses: warm orange.
	assistant: () => ({
		fg: [colors.fgL(), colors.fgC(), 55],
		cursor: [colors.fgL(), colors.fgC(), 55],
		cursorIdle: [0.6, 0, 55],
		bold: [0.9, 0.06, 55],
		code: [0.86, 0.04, 55],
		linkFg: [0.88, 0.15, 55],
		linkBg: [0.3, 0.05, 55],
	}),
	// Thinking: muted blue-grey, recedes.
	thinking: () => ({
		fg: [0.72, 0.03, 250],
		bold: [0.85, 0.02, 250],
		code: [0.78, 0.03, 250],
		linkBg: [0.2, 0.02, 250],
	}),
	// User messages and the prompt input: the same bright blue card.
	user: () => ({ fg: [0.86, 0.16, 215], bg: [0.21, 0.06, 215] }),
	input: () => ({ ...colors.user(), cursor: colors.user().fg! }),
	// Log: neutral, moderately dim.
	log: () => ({ fg: [0.7, 0, 0], code: [0.78, 0, 0], linkBg: [0.3, 0, 0] }),
	// Warnings: amber, noticeable but not fatal.
	warning: () => ({ fg: [0.87, 0.18, 82], bg: [0.2, 0.05, 82], code: [0.92, 0.12, 82], linkBg: [0.28, 0.06, 82] }),
	// Errors: hot red.
	error: () => ({ fg: [0.72, 0.24, 25], bg: [0.2, 0.08, 25], code: [0.84, 0.16, 25], linkBg: [0.24, 0.07, 25] }),
	info: () => ({ fg: [0.74, 0.06, 55], bg: [0.22, 0.025, 55], code: [0.86, 0.04, 55], linkBg: [0.3, 0.025, 55] }),
	// Fork lineage: vivid purple.
	fork: () => ({ fg: [0.8, 0.16, 320], bg: [0.28, 0.06, 320] }),
	// Status line: neutral, with a highlight for what matters.
	status: () => ({ fg: [0.68, 0, 0], highlight: [0.9, 0.01, 250] }),
	// Distinct readable heat steps for the web's status percentages.
	statusCool: () => ({ fg: [0.78, 0.14, 145] }),
	statusWarm: () => ({ fg: [0.86, 0.16, 95] }),
	statusHot: () => ({ fg: [0.76, 0.16, 25] }),
	// Tab labels.
	tab: () => ({
		activeFg: [0.86, 0.16, 200],
		inactiveFg: [0.68, 0, 0],
		doneFg: [0.78, 0.14, 145],
		warningFg: [0.86, 0.16, 95],
		errorFg: colors.error().fg!,
		pausedFg: [0.86, 0.16, 95],
	}),
	// Help bar: keys stand out from descriptions.
	help: () => ({ key: [0.76, 0.008, 250], description: [0.68, 0, 0] }),
	popup: () => ({ neutralFg: [0.68, 0, 0], dangerFg: [0.86, 0.16, 85] }),
	popupCurrent: () => ({ fg: [0.98, 0.04, 55], bg: [0.42, 0.12, 55] }),
	// Search matches in a modal's list: brighter than the items around.
	popupMatch: () => ({ fg: [0.95, 0.14, 95] }),
	popupModelCurrent: () => ({ fg: [0.88, 0, 0], bg: [0.28, 0, 0] }),
	// Edit diffs: green additions, removals in the error hue.
	diff: () => ({ addFg: colors.tab().doneFg!, removeFg: colors.error().fg! }),
	// The web page's own surfaces (custom properties on .page): canvas
	// and text, the focus accent, form fields, borders, and buttons (the
	// picker's selected item too), and search matches. The terminal has its own.
	page: () => ({
		canvas: [0.14, 0.01, 260],
		text: [0.93, 0.01, 260],
		accent: [0.86, 0.16, 200],
		field: [0.18, 0.015, 260],
		// No slate (tasks/README.md, look): lines and buttons are cyan.
		border: [0.5, 0.08, 210],
		button: [0.3, 0.08, 215],
		// Search matches in the picker's list.
		match: [0.92, 0.14, 95],
	}),
	// Tools: each kind its own hue. Red is kept for real failures. A
	// tool without its own entry (tool + capitalised name) uses `tool`.
	tool: () => ({ fg: [colors.fgL(), colors.fgC(), 250], bg: [colors.bgL(), colors.bgC(), 250] }),
	toolBash: () => ({ fg: [colors.fgL(), colors.fgC(), 320], bg: [colors.bgL(), colors.bgC(), 320] }),
	toolEval: () => ({ fg: [colors.fgL(), colors.fgC(), 295], bg: [colors.bgL(), 0.06, 295] }),
	toolRead: () => ({ fg: [colors.fgL(), colors.fgC(), 155], bg: [colors.bgL(), colors.bgC(), 155] }),
	toolGrep: () => colors.toolRead(),
	toolGlob: () => colors.toolRead(),
	toolLs: () => colors.toolRead(),
	toolWrite: () => ({ fg: [0.78, 0.12, 75], bg: [colors.bgL(), 0.04, 75] }),
	toolEdit: () => ({ fg: [0.76, 0.11, 190], bg: [colors.bgL(), 0.04, 190] }),
}

// A theme is a plugin (task d3): /theme links it to plugins/color-theme.ts.
export default (plugin: Plugin) => {
	for (let [key, fn] of Object.entries(look)) plugin.around(colors, key as keyof typeof colors, fn as never)
	plugin.onChange(() => terminal.redraw())
}
