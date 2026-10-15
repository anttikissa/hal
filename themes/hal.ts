// The built-in look, hal, written out as a theme (task d3): copy it to
// themes/<name>.ts, change what you like, then /theme <name>. Every
// color is OKLCH [lightness, chroma, hue]; a style can read another
// through colors (colors.fgL), which sees this theme's values.
// Derived colors (quiet, blinkDim) are functions given the field they
// replace first; every color Hal draws comes from a field here.
// It starts equal to src/common/colors.ts; nothing keeps them in step.

import { terminal } from '../src/client/terminal.ts'
import { colors, type Look } from '../src/common/colors.ts'
import { oklch } from '../src/common/oklch.ts'
import type { Plugin } from '../src/host/plugins.ts'

export const look: Look = {
	// The lightest dark background we design for: where a style has no
	// bg of its own, its text is checked against this (4.5:1, 3:1 for
	// marks; tasks/README.md, readable text).
	screen: [0.15, 0.015, 85],
	// Shared lightness and chroma of the vivid foregrounds and the card
	// backgrounds.
	fgL: 0.84,
	fgC: 0.17,
	bgL: 0.2,
	bgC: 0.05,

	// Derived colors: code calls these, so a theme may override them
	// like any field. quiet: a style's secondary text (hints, ids,
	// command lines, table rules), darker than fg but never below 4.6:1
	// on bg. blinkDim: a blinking tab mark in its dark phase.
	quiet: (_base, fg, bg) => oklch.quiet(fg, bg),
	blinkDim: (_base, fg) => [fg[0] * 0.65, fg[1], fg[2]],
	// Web only, percentages: how much of the current color tints a
	// hovered control (hover; a choice, choiceHover) or the current tab
	// (tab), draws the prompt box bar (entry), quote bar (quote) and
	// table lines (table) and the line before the prompt box's buttons
	// (divider); how much canvas the phone tab sheet's backdrop
	// is (backdrop), and how far the busy dot pulses (pulse).
	mix: { hover: 14, choiceHover: 18, tab: 16, entry: 55, divider: 35, quote: 40, table: 30, backdrop: 60, pulse: 30 },

	// Hal's responses: amber, after Alien's (1979) Nostromo terminals.
	assistant: () => ({
		fg: [colors.fgL, 0.16, 75],
		cursor: [colors.fgL, 0.16, 75],
		cursorIdle: [0.6, 0.04, 75],
		bold: [0.93, 0.12, 80],
		code: [0.88, 0.1, 80],
		linkFg: [0.9, 0.17, 80],
		linkBg: [0.28, 0.06, 75],
	}),
	synthetic: () => colors.assistant(),
	// Thinking: muted blue-gray, recedes.
	thinking: () => ({
		fg: [0.72, 0.03, 250],
		bold: [0.85, 0.02, 250],
		code: [0.78, 0.03, 250],
		linkBg: [0.2, 0.02, 250],
	}),
	// User messages and the prompt input: the same green phosphor card.
	user: () => ({ fg: [0.87, 0.2, 145], bg: [0.2, 0.05, 145] }),
	// Messages and commands from another session: hot pink.
	message: () => ({ fg: [0.8, 0.19, 350], bg: [colors.bgL, 0.07, 350] }),
	// placeholder: the example request in an empty prompt, readable but
	// quieter than typed text.
	input: () => ({ ...colors.user(), cursor: colors.user().fg!, placeholder: [0.5, 0.09, 215] }),
	// Log: neutral, moderately dim.
	log: () => ({ fg: [0.7, 0, 0], code: [0.78, 0, 0], linkBg: [0.3, 0, 0] }),
	// Warnings: amber, noticeable but not fatal.
	warning: () => ({ fg: [0.9, 0.17, 100], bg: [0.21, 0.05, 100], code: [0.94, 0.12, 100], linkBg: [0.28, 0.06, 100] }),
	// Errors: hot red.
	error: () => ({ fg: [0.7, 0.22, 30], bg: [0.2, 0.08, 30], code: [0.82, 0.15, 30], linkBg: [0.25, 0.07, 30] }),
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
		activeFg: [0.87, 0.2, 145],
		inactiveFg: [0.68, 0, 0],
		doneFg: [0.78, 0.14, 145],
		warningFg: [0.86, 0.16, 95],
		errorFg: [0.76, 0.16, 25],
		pausedFg: colors.log().fg!,
	}),
	// The notice stack (task qm): a bar in the event's color on a faint
	// neutral gray, lighter than the screen so its shape shows; never slate.
	notice: () => ({
		fg: [0.9, 0, 0],
		bg: [0.22, 0, 0],
		doneFg: colors.tab().doneFg!,
		failedFg: colors.error().fg!,
		attentionFg: colors.tab().warningFg!,
	}),
	// Help bar: keys stand out from descriptions.
	help: () => ({ key: [0.76, 0.008, 250], description: [0.68, 0, 0] }),
	popup: () => ({ neutralFg: [0.68, 0, 0], dangerFg: [0.86, 0.16, 85] }),
	// The selected item: a lighter tint of the color around it.
	popupCurrent: (_base, around) => {
		let tint = around[1] >= 0.02
		return { fg: [0.98, tint ? 0.04 : 0, around[2]], bg: [0.42, tint ? 0.11 : 0, around[2]] }
	},
	// Search matches in a modal's list: brighter than the items around.
	popupMatch: () => ({ fg: [0.95, 0.14, 95] }),
	popupModelCurrent: () => ({ fg: [0.88, 0, 0], bg: [0.28, 0, 0] }),
	// Edit diffs and a failed command's exit status: soft pastels, easy on
	// the eyes (the error red is too harsh for so many lines).
	diff: () => ({ addFg: [0.8, 0.16, 146], removeFg: [0.72, 0.16, 28] }),
	// The web page's own surfaces (custom properties on .page): canvas
	// and text, the focus accent, form fields, borders, and buttons (the
	// picker's selected item too), and search matches. The terminal has its own.
	page: () => ({
		canvas: [0.13, 0.015, 85],
		text: [0.88, 0.12, 85],
		accent: [0.86, 0.2, 145],
		field: [0.17, 0.02, 85],
		// Brown-black surfaces with warm lines and buttons.
		border: [0.5, 0.07, 85],
		button: [0.25, 0.04, 85],
		// Search matches in the picker's list.
		match: [0.92, 0.14, 95],
		// Where a press or a linked card's flash starts (web/flash.ts).
		flash: [1, 0, 0],
	}),
	// Tools: each kind its own hue. Red is kept for real failures. A
	// tool without its own entry (tool + capitalized name) uses `tool`.
	tool: () => ({ fg: [colors.fgL, colors.fgC, 250], bg: [colors.bgL, colors.bgC, 250] }),
	toolBash: () => ({ fg: [colors.fgL, colors.fgC, 320], bg: [colors.bgL, colors.bgC, 320] }),
	toolEval: () => ({ fg: [colors.fgL, colors.fgC, 295], bg: [colors.bgL, 0.06, 295] }),
	toolRead: () => ({ fg: [colors.fgL, colors.fgC, 155], bg: [colors.bgL, colors.bgC, 155] }),
	toolGrep: () => colors.toolRead(),
	toolGlob: () => colors.toolRead(),
	toolLs: () => colors.toolRead(),
	toolWrite: () => ({ fg: [0.78, 0.12, 75], bg: [colors.bgL, 0.04, 75] }),
	toolEdit: () => ({ fg: [0.76, 0.11, 190], bg: [colors.bgL, 0.04, 190] }),
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
