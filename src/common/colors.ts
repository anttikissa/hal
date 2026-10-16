// The built-in look, hal, as code; other themes are plugins that
// replace fields (themes/, task d3). The shared values (fgL, screen, mix) are plain
// values; every other top-level field is a function, read at call time:
// styles computed from them, so overriding a value (colors.fgL = 0.9 from
// local.ts, or plugin.set(colors, 'fgL', 0.9), which can undo it) moves
// everything derived from it. A style names its colors: fg and bg, plus extras
// such as bold, code or cursor for later renderers. Every color is
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
// A plain value (fgL, screen, mix) is replaced by a plain value (plugin.set).
export type Look = { [K in keyof Colors]?: Colors[K] extends (...args: any[]) => unknown ? (base: Colors[K], ...args: Parameters<Colors[K]>) => ReturnType<Colors[K]> : Colors[K] }

// Fields that derive a color from others, so take arguments; every
// other field is a plain value (fgL, screen, mix) or a style, a function
// read with no arguments.
export const DERIVED = ['quiet', 'title', 'blinkDim', 'heat', 'toolOutput', 'popupCurrent'] as const

// Plain names for colors.project() p0..p7, so a model can answer "which
// is the cyan project" (task jm).
export const projectColorNames = ['magenta', 'pink', 'orange', 'amber', 'green', 'cyan', 'blue', 'violet']

export const colors = {
	// The lightest dark background we design for: where a style has no
	// bg of its own, its text is checked against this (4.5:1, 3:1 for
	// marks; tasks/README.md, readable text).
	screen: [0.15, 0.015, 85] as Oklch,
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
	quiet: (fg: Oklch, bg: Oklch): Oklch => oklch.quiet(fg, bg),
	title: (fg: Oklch): Oklch => [Math.min(0.96, fg[0] + 0.12), fg[1] / 2, fg[2]],
	blinkDim: (fg: Oklch): Oklch => [fg[0] * 0.65, fg[1], fg[2]],
	// toolOutput: a tool's output text under its call, from the call's
	// fg: darker at full chroma, so it reads below the command without
	// turning gray (task hr).
	toolOutput: (fg: Oklch): Oklch => [fg[0] - 0.22, fg[1], fg[2]],
	// A percentage used (context, quota) as one continuous color: green
	// when little is used, through yellow and orange, to red when all is.
	// The web gets it as classes .heat-0 to .heat-100 (host/web.ts).
	heat: (used: number): Oklch => [0.78, 0.14, 145 - 1.2 * Math.max(0, Math.min(100, used))],
	// Web only, percentages: how much of the current color tints a
	// hovered control (hover; a choice, choiceHover) or the current tab
	// (tab), draws the prompt box bar (entry), quote bar (quote) and
	// table lines (table) and the line before the prompt box's buttons
	// (divider); how much canvas the phone tab sheet's backdrop
	// is (backdrop), and how far the busy dot pulses (pulse).
	mix: { hover: 14, choiceHover: 18, tab: 16, entry: 55, divider: 35, quote: 40, table: 30, backdrop: 60, pulse: 30 },

	// Hal's responses: amber, after Alien's (1979) Nostromo terminals.
	assistant: (): Style => ({
		fg: [colors.fgL, 0.16, 75],
		cursor: [colors.fgL, 0.16, 75],
		cursorIdle: [0.6, 0.04, 75],
		bold: [0.93, 0.12, 80],
		code: [0.88, 0.1, 80],
		linkFg: [0.9, 0.17, 80],
		linkBg: [0.28, 0.06, 75],
	}),
	// Neutral gray cards: the user's, Hal's own remarks, questions,
	// commits and command responses, so color marks only tools and replies.
	plain: (): Style => ({ fg: [colors.fgL, 0, 0], bg: [colors.bgL, 0, 0] }),
	synthetic: (): Style => colors.plain(),
	// Thinking: neutral gray, distinct from replies through italic text.
	thinking: (): Style => ({ ...colors.log(), bold: colors.log().code! }),
	// User messages and the prompt input: the same neutral card.
	user: (): Style => colors.plain(),
	// Messages and commands from another session (task 9p): hot pink,
	// apart from bash's magenta and the error red.
	message: (): Style => ({ fg: [0.8, 0.19, 350], bg: [colors.bgL, 0.07, 350] }),
	// placeholder: the example request in an empty prompt, readable but
	// quieter than typed text.
	input: (): Style => ({ ...colors.user(), cursor: colors.user().fg!, placeholder: oklch.faint(colors.user().fg!, colors.user().bg!) }),
	// Log: neutral, moderately dim.
	log: (): Style => ({ fg: [0.7, 0, 0], code: [0.78, 0, 0], linkBg: [0.3, 0, 0] }),
	// Warnings: amber, noticeable but not fatal.
	warning: (): Style => ({ fg: [0.9, 0.17, 100], bg: [0.21, 0.05, 100], code: [0.94, 0.12, 100], linkBg: [0.28, 0.06, 100] }),
	// Questions waiting on the user: neutral, like the user's own card.
	question: (): Style => colors.plain(),
	// Errors: the diff's removal red.
	error: (): Style => ({ fg: colors.diff().removeFg!, bg: [0.2, 0.08, 30], code: colors.diff().removeFg!, linkBg: [0.25, 0.07, 30] }),
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
		activeFg: [0.87, 0.2, 145],
		inactiveFg: [0.68, 0, 0],
		doneFg: [0.78, 0.14, 145],
		warningFg: [0.86, 0.16, 95],
		errorFg: [0.76, 0.16, 25],
		pausedFg: colors.log().fg!,
		// Background jobs running: bash's magenta.
		jobsFg: [colors.fgL, colors.fgC, 320],
	}),
	// Project colors (task 22), CSS --p0..--p7: one L and C, hues spread
	// with a single cyan; the display clips what is out of its gamut.
	project: (): Style => Object.fromEntries([327.5, 7.5, 47.5, 87.5, 127.5, 195, 247.5, 287.5].map((h, i) => [`p${i}`, [0.778, 0.225, h] as Oklch])),
	// Dim tints of the project colors for a notice's background (task
	// qm): p0Bg..p7Bg, each the hue of its p0..p7.
	projectTint: (): Style => Object.fromEntries(Object.entries(colors.project()).map(([k, c]) => [`${k}Bg`, [0.2, 0.05, c![2]] as Oklch])),
	// The notice stack (task qm): a bar in the event's color on a faint
	// neutral gray, lighter than the screen so its shape shows; never slate.
	notice: (): Style => ({
		fg: [0.9, 0, 0],
		bg: [0.22, 0, 0],
		doneFg: colors.tab().doneFg!,
		failedFg: colors.error().fg!,
		attentionFg: colors.tab().warningFg!,
		// A mid-turn update (task py) asks nothing: neutral.
		updateFg: [0.9, 0, 0],
		// Commits (task hy): violet, apart from the session outcomes.
		commitFg: colors.commitCard().fg!,
	}),
	// A commit card (task 179), web class .commit-card: neutral.
	commitCard: (): Style => colors.plain(),
	// Help bar: keys stand out from descriptions; the web's update reload
	// hint (task 7t) is amber, a special case only when new code waits.
	help: (): Style => ({ key: [0.76, 0.008, 250], description: [0.68, 0, 0], update: [0.82, 0.17, 70] }),
	popup: (): Style => ({ neutralFg: [0.68, 0, 0], dangerFg: [0.86, 0.16, 85] }),
	// The selected item (a picker row, a question's chosen answer): a
	// lighter tint of the color around it, so green in a question and
	// gray in the neutral picker (the user's choice, option G).
	popupCurrent: (around: Oklch): Style => {
		let tint = around[1] >= 0.02
		return { fg: [0.98, tint ? 0.04 : 0, around[2]], bg: [0.42, tint ? 0.11 : 0, around[2]] }
	},
	// Search matches in a modal's list: brighter than the items around.
	popupMatch: (): Style => ({ fg: [0.95, 0.14, 95] }),
	// Plumbing beside a modal row, such as the config.ason text of the
	// selected setting: dimmer than the row's text, yet readable on the
	// selected row's popupCurrent background (L 0.42).
	popupNote: (): Style => ({ fg: [0.8, 0, 0] }),
	popupModelCurrent: (): Style => ({ fg: [0.88, 0, 0], bg: [0.28, 0, 0] }),
	// Exit 1 is neutral; other nonzero statuses use the error red (tasks wm0, j92).
	exit: (): Style => ({ fg: colors.diff().removeFg!, neutralFg: colors.log().fg! }),
	// Edit diffs: soft pastels, easy on the eyes. Errors and exit
	// statuses share the removal red.
	diff: (): Style => ({ addFg: [0.8, 0.16, 146], removeFg: [0.72, 0.16, 28] }),
	// The web page's own surfaces (custom properties on .page): canvas
	// and text, the focus accent, form fields, borders, and buttons (the
	// picker's selected item too), and search matches. The terminal has its own.
	page: (): Style => ({
		canvas: [0.13, 0.015, 85],
		overlayBg: [0, 0, 0],
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
	tool: (): Style => ({ fg: [colors.fgL, colors.fgC, 250], bg: [colors.bgL, colors.bgC, 250] }),
	toolBash: (): Style => ({ fg: [colors.fgL, colors.fgC, 320], bg: [colors.bgL, colors.bgC, 320] }),
	toolEdit: (): Style => colors.toolBash(),
	toolEval: (): Style => ({ fg: [colors.fgL, colors.fgC, 295], bg: [colors.bgL, 0.06, 295] }),
	toolRead: (): Style => ({ fg: [colors.fgL, colors.fgC, 155], bg: [colors.bgL, colors.bgC, 155] }),
	toolGrep: (): Style => colors.toolRead(),
	toolGlob: (): Style => colors.toolRead(),
	toolLs: (): Style => colors.toolRead(),
	// Inter-tab messages, both directions, in the message pink.
	toolSend: (): Style => colors.message(),
}

