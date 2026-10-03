// The built-in look, hal, as code; other themes are plugins that
// replace fields (themes/, task d3). Every top-level field is a function, read at call
// time: shared values (fgL: () => 0.8, screen) and styles computed from
// them, so overriding a value from local.ts (colors.fgL = () => 0.9, or
// around(colors, 'fgL', ...) from a plugin, which can undo it) moves
// everything derived from it. A style names its colours: fg and bg, plus extras
// such as bold, code or cursor for later renderers. Every colour is
// OKLCH [lightness, chroma, hue]: equal L and C across hues look equally
// bright and vivid.
//
// The terminal turns styles into escape codes (client/ansi.ts); the
// host turns them into CSS for the web page (host/web.ts), which never
// sees these functions. A style key becomes a CSS class in kebab case:
// toolBash is .tool-bash.

import { oklch, type Oklch } from './oklch.ts'

export type Style = { [part: string]: Oklch }

type Colors = typeof colors
// A theme (task d3): replacements for some fields, each given the field
// it replaces, so it can change one part of a style and keep the rest.
export type Look = { [K in keyof Colors]?: (base: Colors[K], ...args: Parameters<Colors[K]>) => ReturnType<Colors[K]> }

// Fields that derive a colour from others, so take arguments; every
// other field is a value or a style, read with no arguments.
export const DERIVED = ['quiet', 'blinkDim', 'heat', 'toolOutput'] as const

// Plain names for colors.project() p0..p7, so a model can answer "which
// is the cyan project" (task jm).
export const projectColorNames = ['magenta', 'pink', 'orange', 'amber', 'green', 'cyan', 'blue', 'violet']

export const colors = {
	// The lightest dark background we design for: where a style has no
	// bg of its own, its text is checked against this (4.5:1, 3:1 for
	// marks; tasks/README.md, readable text).
	screen: (): Oklch => [0.16, 0.01, 260],
	// Shared lightness and chroma of the vivid foregrounds and the card
	// backgrounds.
	fgL: (): number => 0.85,
	fgC: (): number => 0.16,
	bgL: (): number => 0.2,
	bgC: (): number => 0.05,

	// Derived colours: code calls these, so a theme may override them
	// like any field. quiet: a style's secondary text (hints, ids,
	// command lines, table rules), darker than fg but never below 4.6:1
	// on bg. blinkDim: a blinking tab mark in its dark phase.
	quiet: (fg: Oklch, bg: Oklch): Oklch => oklch.quiet(fg, bg),
	blinkDim: (fg: Oklch): Oklch => [fg[0] * 0.65, fg[1], fg[2]],
	// toolOutput: a tool's output text under its call, from the call's
	// fg: darker at full chroma, so it reads below the command without
	// turning grey (task hr).
	toolOutput: (fg: Oklch): Oklch => [fg[0] - 0.2, fg[1], fg[2]],
	// A percentage used (context, quota) as one continuous colour: green
	// when little is used, through yellow and orange, to red when all is.
	// The web gets it as classes .heat-0 to .heat-100 (host/web.ts).
	heat: (used: number): Oklch => [0.78, 0.14, 145 - 1.2 * Math.max(0, Math.min(100, used))],
	// Web only, percentages: how much of the current colour tints a
	// hovered control (hover; a choice, choiceHover) or the current tab
	// (tab), draws the prompt box bar (entry), quote bar (quote) and
	// table lines (table) and the line before the prompt box's buttons
	// (divider); how much canvas the phone tab sheet's backdrop
	// is (backdrop), and how far the busy dot pulses (pulse).
	mix: () => ({ hover: 14, choiceHover: 18, tab: 16, entry: 55, divider: 35, quote: 40, table: 30, backdrop: 60, pulse: 30 }),

	// Hal's responses: warm orange.
	assistant: (): Style => ({
		fg: [colors.fgL(), colors.fgC(), 57],
		cursor: [colors.fgL(), colors.fgC(), 55],
		cursorIdle: [0.6, 0, 55],
		bold: [0.9, 0.06, 55],
		code: [0.86, 0.04, 55],
		linkFg: [0.88, 0.15, 55],
		linkBg: [0.3, 0.05, 55],
	}),
	// Thinking: muted blue-grey, recedes.
	thinking: (): Style => ({
		fg: [0.72, 0.03, 250],
		bold: [0.85, 0.02, 250],
		code: [0.78, 0.03, 250],
		linkBg: [0.2, 0.02, 250],
	}),
	// User messages and the prompt input: the same bright blue card.
	user: (): Style => ({ fg: [0.86, 0.16, 215], bg: [0.21, 0.06, 215] }),
	// placeholder: the example request in an empty prompt, readable but
	// quieter than typed text.
	input: (): Style => ({ ...colors.user(), cursor: colors.user().fg!, placeholder: oklch.faint(colors.user().fg!, colors.user().bg!) }),
	// Log: neutral, moderately dim.
	log: (): Style => ({ fg: [0.7, 0, 0], code: [0.78, 0, 0], linkBg: [0.3, 0, 0] }),
	// Warnings: amber, noticeable but not fatal.
	warning: (): Style => ({ fg: [0.87, 0.18, 82], bg: [0.2, 0.05, 82], code: [0.92, 0.12, 82], linkBg: [0.28, 0.06, 82] }),
	// Questions waiting on the user: green, apart from warnings.
	question: (): Style => ({ fg: [colors.fgL(), colors.fgC(), 150], bg: [colors.bgL(), colors.bgC(), 150], code: [0.92, 0.1, 150], linkBg: [0.28, 0.06, 150] }),
	// Errors: hot red.
	error: (): Style => ({ fg: [0.72, 0.24, 25], bg: [0.2, 0.08, 25], code: [0.84, 0.16, 25], linkBg: [0.24, 0.07, 25] }),
	info: (): Style => ({ fg: [0.74, 0.06, 55], bg: [0.22, 0.025, 55], code: [0.86, 0.04, 55], linkBg: [0.3, 0.025, 55] }),
	// Fork lineage: vivid purple.
	fork: (): Style => ({ fg: [0.8, 0.16, 320], bg: [0.28, 0.06, 320] }),
	// Status line: neutral, with a highlight for what matters.
	status: (): Style => ({ fg: [0.68, 0, 0], highlight: [0.9, 0.01, 250] }),
	// Three distinct readable steps: the context graph's token kinds.
	statusCool: (): Style => ({ fg: [0.78, 0.14, 145] }),
	statusWarm: (): Style => ({ fg: [0.86, 0.16, 95] }),
	statusHot: (): Style => ({ fg: [0.76, 0.16, 25] }),
	// Tab labels.
	tab: (): Style => ({
		activeFg: [0.86, 0.16, 200],
		inactiveFg: [0.68, 0, 0],
		doneFg: [0.78, 0.14, 145],
		warningFg: [0.86, 0.16, 95],
		errorFg: colors.error().fg!,
		pausedFg: [0.86, 0.16, 95],
	}),
	// Project colors (task 22), CSS --p0..--p7: one L and C, hues spread
	// with a single cyan; the display clips what is out of its gamut.
	project: (): Style => Object.fromEntries([327.5, 7.5, 47.5, 87.5, 127.5, 195, 247.5, 287.5].map((h, i) => [`p${i}`, [0.778, 0.225, h] as Oklch])),
	// The notice stack (task qm): a bar in the event's colour on near
	// black, never slate.
	notice: (): Style => ({
		fg: [0.9, 0, 0],
		bg: [0.13, 0, 0],
		doneFg: colors.tab().doneFg!,
		failedFg: colors.error().fg!,
		attentionFg: colors.tab().warningFg!,
		// A mid-turn update (task py) asks nothing: neutral.
		updateFg: [0.9, 0, 0],
		// Commits (task hy): violet, apart from the session outcomes.
		commitFg: [0.8, 0.16, 300],
	}),
	// Help bar: keys stand out from descriptions.
	help: (): Style => ({ key: [0.76, 0.008, 250], description: [0.68, 0, 0] }),
	popup: (): Style => ({ neutralFg: [0.68, 0, 0], dangerFg: [0.86, 0.16, 85] }),
	popupCurrent: (): Style => ({ fg: [0.98, 0.04, 55], bg: [0.42, 0.12, 55] }),
	// Search matches in a modal's list: brighter than the items around.
	popupMatch: (): Style => ({ fg: [0.95, 0.14, 95] }),
	popupModelCurrent: (): Style => ({ fg: [0.88, 0, 0], bg: [0.28, 0, 0] }),
	// Edit diffs: green additions, removals in the error hue.
	diff: (): Style => ({ addFg: colors.tab().doneFg!, removeFg: colors.error().fg! }),
	// The web page's own surfaces (custom properties on .page): canvas
	// and text, the focus accent, form fields, borders, and buttons (the
	// picker's selected item too), and search matches. The terminal has its own.
	page: (): Style => ({
		canvas: [0.14, 0.01, 260],
		overlayBg: [0, 0, 0],
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
	tool: (): Style => ({ fg: [colors.fgL(), colors.fgC(), 250], bg: [colors.bgL(), colors.bgC(), 250] }),
	toolBash: (): Style => ({ fg: [colors.fgL(), colors.fgC(), 320], bg: [colors.bgL(), colors.bgC(), 320] }),
	toolEval: (): Style => ({ fg: [colors.fgL(), colors.fgC(), 295], bg: [colors.bgL(), 0.06, 295] }),
	toolRead: (): Style => ({ fg: [colors.fgL(), colors.fgC(), 155], bg: [colors.bgL(), colors.bgC(), 155] }),
	toolGrep: (): Style => colors.toolRead(),
	toolGlob: (): Style => colors.toolRead(),
	toolLs: (): Style => colors.toolRead(),
	toolWrite: (): Style => ({ fg: [0.78, 0.12, 75], bg: [colors.bgL(), 0.04, 75] }),
	toolEdit: (): Style => ({ fg: [0.76, 0.11, 190], bg: [colors.bgL(), 0.04, 190] }),
}

