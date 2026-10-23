// One source of colors for the terminal and the web: the built-in,
// nameless look, as code. It is grayscale, so a user who changes one
// field sees where it is used; Hal amber marks only the Hal home and
// percentages. Themes are plugins that replace fields (themes/, task d3).
//
// The shared values (fgL, screen, mix) are plain values. Every other
// top-level field is a function, read at call time, that computes styles
// from them. So overriding a value (colors.fgL = 0.9 from local.ts, or
// plugin.set(colors, 'fgL', 0.9), which can undo it) moves everything
// derived from it. A style names its colors: fg and bg, plus extras such
// as bold, code or cursor for later renderers. Every color is OKLCH
// [lightness, chroma, hue]: equal L and C across hues look equally
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
export type Look = {
	[K in keyof Colors]?: Colors[K] extends (...args: any[]) => unknown
		? (base: Colors[K], ...args: Parameters<Colors[K]>) => ReturnType<Colors[K]>
		: Colors[K]
}

// Fields that derive a color from others, so take arguments; every
// other field is a plain value (fgL, screen, mix) or a style, a function
// read with no arguments.
export const DERIVED = ['quiet', 'title', 'blinkDim', 'heat', 'toolOutput', 'popupCurrent', 'cardHue'] as const

// Plain names for colors.project() p0..p7, so a model can answer "which
// is the cyan project" (task jm).
export const projectColorNames = ['magenta', 'pink', 'orange', 'amber', 'green', 'cyan', 'blue', 'violet']

// Hal amber, for the few things the grayscale look colors.
const amber: Oklch = [0.84, 0.16, 75]
const gray = (l: number): Oklch => [l, 0, 0]

export const colors = {
	// The lightest dark background we design for: where a style has no
	// bg of its own, its text is checked against this (4.5:1, 3:1 for
	// marks; tasks/README.md, readable text).
	screen: gray(0.15),
	// Shared lightness and chroma of the foregrounds and the card
	// backgrounds.
	fgL: 0.84,
	fgC: 0,
	bgL: 0.2,
	bgC: 0,

	// Derived colors: code calls these, so a theme may override them
	// like any field. quiet: a style's secondary text (hints, ids,
	// command lines, table rules), darker than fg but never below 4.6:1
	// on bg. blinkDim: a blinking tab mark in its dark phase.
	quiet: (fg: Oklch, bg: Oklch): Oklch => oklch.quiet(fg, bg),
	title: (fg: Oklch): Oklch => [Math.min(0.96, oklch.fit(fg)[0] + 0.04), fg[1] * 0.75, fg[2]],
	blinkDim: (fg: Oklch): Oklch => [fg[0] * 0.65, fg[1], fg[2]],
	// toolOutput: a tool's output text under its call, darker than the
	// call's fg (task hr).
	toolOutput: (fg: Oklch): Oklch => [fg[0] - 0.18, fg[1], fg[2]],
	// A percentage used (context, quota), web classes .heat-0 to
	// .heat-100 (host/web.ts): Hal amber at any amount.
	heat: (_used: number): Oklch => amber,
	// Web only, percentages: how much of the current color tints a
	// hovered control (hover; a choice, choiceHover) or the current tab
	// (tab), draws the prompt box bar (entry), quote bar (quote) and
	// table lines (table) and the line before the prompt box's buttons
	// (divider); how much canvas the phone tab sheet's backdrop
	// is (backdrop), and how far the busy dot pulses (pulse).
	mix: { hover: 14, choiceHover: 18, tab: 16, entry: 55, divider: 35, quote: 40, table: 30, backdrop: 60, pulse: 30 },

	// Hal's responses.
	assistant: (): Style => ({
		fg: gray(colors.fgL),
		cursor: gray(colors.fgL),
		cursorIdle: gray(0.6),
		title: gray(0.93),
		bold: gray(0.95),
		code: gray(0.9),
		linkFg: gray(0.95),
		linkBg: gray(0.28),
	}),
	// Questions, commits and command responses.
	plain: (): Style => ({ fg: gray(0.78), bg: gray(colors.bgL), title: gray(0.95) }),
	// Thinking: distinct from replies through italic text.
	thinking: (): Style => ({ ...colors.log(), bold: colors.log().code! }),
	// User messages and the prompt input: brighter than replies.
	user: (): Style => ({ fg: gray(0.92), bg: gray(0.24), title: gray(0.97) }),
	// Messages and commands from another session (task 9p).
	message: (): Style => ({ fg: gray(0.8), bg: gray(0.22), title: gray(0.93), output: gray(0.7) }),
	// placeholder: the example request in an empty prompt, readable but
	// quieter than typed text.
	input: (): Style => ({
		...colors.user(),
		cursor: colors.user().fg!,
		placeholder: oklch.faint(colors.user().fg!, colors.user().bg!),
	}),
	log: (): Style => ({ fg: gray(0.7), code: gray(0.78), linkBg: gray(0.3) }),
	warning: (): Style => ({ fg: gray(0.94), bg: gray(0.26), code: gray(0.97), linkBg: gray(0.32) }),
	question: (): Style => colors.plain(),
	error: (): Style => ({ fg: gray(0.94), bg: gray(0.3), title: gray(0.98), code: gray(0.97), linkBg: gray(0.36) }),
	info: (): Style => ({ fg: gray(0.74), bg: gray(0.22), code: gray(0.86), linkBg: gray(0.3) }),
	fork: (): Style => ({ fg: gray(0.8), bg: gray(0.28) }),
	// Status line, with a highlight for what matters.
	status: (): Style => ({ fg: gray(0.68), highlight: gray(0.9) }),
	// The Hal home's path in the status row.
	halHome: (): Style => ({ fg: amber }),
	// The context graph's token kinds: three readable steps.
	statusCool: (): Style => ({ fg: gray(0.6) }),
	statusWarm: (): Style => ({ fg: gray(0.78) }),
	statusHot: (): Style => ({ fg: gray(0.95) }),
	// Tab labels.
	tab: (): Style => ({
		activeFg: gray(0.95),
		inactiveFg: gray(0.68),
		doneFg: gray(0.85),
		warningFg: gray(0.95),
		errorFg: gray(0.95),
		pausedFg: colors.log().fg!,
		jobsFg: gray(colors.fgL),
	}),
	// Project colors (task 22), CSS --p0..--p7.
	project: (): Style => Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [`p${i}`, gray(0.8)])),
	// A notice's background tints (task qm): p0Bg..p7Bg.
	projectTint: (): Style => Object.fromEntries(Object.keys(colors.project()).map((k) => [`${k}Bg`, gray(0.2)])),
	// The notice stack (task qm): a bar in the event's color on a
	// background lighter than the screen, so its shape shows.
	notice: (): Style => ({
		fg: gray(0.9),
		bg: gray(0.22),
		doneFg: colors.tab().doneFg!,
		failedFg: colors.error().fg!,
		attentionFg: colors.tab().warningFg!,
		updateFg: gray(0.9),
		commitFg: colors.commitCard().fg!,
	}),
	// A commit card (task 179), web class .commit-card.
	commitCard: (): Style => colors.plain(),
	// Help bar: keys stand out from descriptions; update: the web's
	// reload hint (task 7t).
	help: (): Style => ({ key: gray(0.8), description: gray(0.68), update: gray(0.95) }),
	popup: (): Style => ({ neutralFg: gray(0.68), dangerFg: gray(0.95) }),
	// The selected item (a picker row, a question's chosen answer): a
	// lighter tint of the color around it.
	popupCurrent: (around: Oklch): Style => {
		let tint = around[1] >= 0.02
		return { fg: [0.98, tint ? 0.04 : 0, around[2]], bg: [0.42, tint ? 0.11 : 0, around[2]] }
	},
	// Search matches in a modal's list: brighter than the items around.
	popupMatch: (): Style => ({ fg: gray(1) }),
	// Plumbing beside a modal row, such as the config.ason text of the
	// selected setting: dimmer than the row's text, yet readable on the
	// selected row's popupCurrent background (L 0.42).
	popupNote: (): Style => ({ fg: gray(0.8) }),
	popupModelCurrent: (): Style => ({ fg: gray(0.88), bg: gray(0.28) }),
	// Exit 1 is neutral; other nonzero statuses use the error color (tasks wm0, j92).
	exit: (): Style => ({ fg: colors.diff().removeFg!, neutralFg: colors.log().fg! }),
	// Edit diffs: additions bright, removals dim.
	diff: (): Style => ({ addFg: gray(0.92), removeFg: gray(0.62) }),
	// The web page's own surfaces (custom properties on .page), taken from
	// the terminal's fields so both match: fields and the focus accent are
	// the prompt's colors, text and buttons plain's, borders the terminal
	// dialog frame's. Canvas, overlay, matches and flashes are web-only.
	page: (): Style => ({
		canvas: gray(0.13),
		overlayBg: gray(0),
		text: colors.plain().fg!,
		accent: colors.input().fg!,
		field: colors.input().bg!,
		border: colors.popup().neutralFg!,
		button: colors.plain().bg!,
		// Search matches in the picker's list.
		match: gray(1),
		// Where a press or a linked card's flash starts (web/flash.ts).
		flash: gray(1),
	}),
	// Tools: a tool without its own entry (tool + camel-case name) uses
	// `tool`. Read-only tools share toolRead, tools with writes or side
	// effects toolBash, messages toolSend.
	tool: (): Style => ({ fg: gray(colors.fgL), bg: gray(colors.bgL) }),
	toolRead: (): Style => colors.tool(),
	toolReadEntry: (): Style => colors.toolRead(),
	toolGrep: (): Style => colors.toolRead(),
	toolInspect: (): Style => colors.toolRead(),
	toolGoogle: (): Style => colors.toolRead(),
	toolWait: (): Style => colors.toolRead(),
	toolHelp: (): Style => colors.toolRead(),
	toolBash: (): Style => colors.tool(),
	toolEdit: (): Style => colors.toolBash(),
	toolCommand: (): Style => colors.toolBash(),
	toolSpawn: (): Style => colors.toolBash(),
	toolStop: (): Style => colors.toolBash(),
	toolNotify: (): Style => colors.toolBash(),
	toolSend: (): Style => colors.message(),
	// A plugin tool's own hue (Tool.card.hue, task m3a) at the levels
	// every tool shares; the web has a class per 5° (.tool-hue-150).
	cardHue: (hue: number): Style => ({ fg: [colors.fgL, colors.fgC, hue], bg: [colors.bgL, colors.bgC, hue] }),
}
