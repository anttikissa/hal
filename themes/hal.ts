// Hal's own colors: amber replies, cyan input and tinted tool cards on
// brown-black, every colors field written out (task d3). Copy it to
// themes/<name>.ts, change what you like, then /theme <name>. Every
// color is OKLCH [lightness, chroma, hue]; a style can read another
// through colors (colors.fgL), which sees this theme's values.
// Derived colors (quiet, blinkDim) are functions given the field they
// replace first; every color Hal draws comes from a field here.

import { render } from '../src/client/render.ts'
import { colors, type Look, type Style } from '../src/common/colors.ts'
import { oklch, type Oklch } from '../src/common/oklch.ts'
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
	quiet: (_base, fg: Oklch, bg: Oklch): Oklch => oklch.quiet(fg, bg),
	title: (_base, fg: Oklch): Oklch => [Math.min(0.96, oklch.fit(fg)[0] + 0.04), fg[1] * 0.75, fg[2]],
	blinkDim: (_base, fg: Oklch): Oklch => [fg[0] * 0.65, fg[1], fg[2]],
	// toolOutput: a tool's output text under its call, from the call's
	// fg: darker at full chroma, so it reads below the command without
	// turning gray (task hr).
	toolOutput: (_base, fg: Oklch): Oklch => [fg[0] - 0.18, fg[1], fg[2]],
	// A percentage used (context, quota) as one continuous color: green
	// when little is used, through yellow and orange, to red when all is.
	// The web gets it as classes .heat-0 to .heat-100 (host/web.ts).
	heat: (_base, used: number): Oklch => [0.78, 0.14, 145 - 1.2 * Math.max(0, Math.min(100, used))],
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
		title: [0.915, 0.1, 84],
		bold: [0.93, 0.12, 80],
		code: [0.88, 0.1, 80],
		linkFg: [0.9, 0.17, 80],
		linkBg: [0.28, 0.06, 75],
	}),
	// Neutral gray cards: questions, commits and command responses.
	plain: (): Style => ({ fg: [0.78, 0, 0], bg: [colors.bgL, 0, 0], title: [0.95, 0, 0] }),
	// Thinking: neutral gray, distinct from replies through italic text.
	thinking: (): Style => ({ ...colors.log(), bold: colors.log().code! }),
	// User messages and the prompt input: cyan.
	user: (): Style => ({ fg: [0.86, 0.16, 215], bg: [0.21, 0.06, 215], title: [0.935, 0.06, 212] }),
	// Messages and commands from another session (task 9p): hot pink,
	// apart from bash's magenta and the error red.
	message: (): Style => ({
		fg: [0.62, 0.18, 350],
		bg: [colors.bgL, 0.08, 0],
		title: [0.82, 0.18, 350],
		output: [0.62, 0.18, 350],
	}),
	// placeholder: the example request in an empty prompt, readable but
	// quieter than typed text.
	input: (): Style => ({
		...colors.user(),
		cursor: colors.user().fg!,
		placeholder: oklch.faint(colors.user().fg!, colors.user().bg!),
	}),
	// Log: neutral, moderately dim.
	log: (): Style => ({ fg: [0.7, 0, 0], code: [0.78, 0, 0], linkBg: [0.3, 0, 0] }),
	// Warnings: amber, noticeable but not fatal.
	warning: (): Style => ({
		fg: [0.9, 0.17, 100],
		bg: [0.21, 0.05, 100],
		code: [0.94, 0.12, 100],
		linkBg: [0.28, 0.06, 100],
	}),
	// Questions waiting on the user: neutral, like the user's own card.
	question: (): Style => colors.plain(),
	// Errors: the diff's removal red, under a clearly brighter title.
	error: (): Style => ({
		fg: colors.diff().removeFg!,
		bg: [0.2, 0.08, 30],
		title: [0.9, 0.08, 28],
		code: colors.diff().removeFg!,
		linkBg: [0.25, 0.07, 30],
	}),
	info: (): Style => ({
		fg: [0.74, 0.06, 55],
		bg: [0.22, 0.025, 55],
		code: [0.86, 0.04, 55],
		linkBg: [0.3, 0.025, 55],
	}),
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
	project: (): Style =>
		Object.fromEntries(
			[327.5, 7.5, 47.5, 87.5, 127.5, 195, 247.5, 287.5].map((h, i) => [`p${i}`, [0.778, 0.225, h] as Oklch]),
		),
	// Dim tints of the project colors for a notice's background (task
	// qm): p0Bg..p7Bg, each the hue of its p0..p7.
	projectTint: (): Style =>
		Object.fromEntries(Object.entries(colors.project()).map(([k, c]) => [`${k}Bg`, [0.2, 0.05, c![2]] as Oklch])),
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
	popupCurrent: (_base, around: Oklch): Style => {
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
	// statuses share the removal red. A combined diff's second column
	// (add2, remove2) is blue and orange.
	diff: (): Style => ({
		addFg: [0.8, 0.16, 146],
		removeFg: [0.72, 0.16, 28],
		add2Fg: [0.78, 0.13, 245],
		remove2Fg: [0.8, 0.14, 65],
	}),
	// The web page's own surfaces (custom properties on .page), taken from
	// the terminal's fields so both match: fields and the focus accent are
	// the prompt's colors, text and buttons plain's, borders the terminal
	// dialog frame's. Canvas, overlay, matches and flashes are web-only.
	page: (): Style => ({
		canvas: [0.13, 0.015, 85],
		overlayBg: [0, 0, 0],
		text: colors.plain().fg!,
		accent: colors.input().fg!,
		field: colors.input().bg!,
		border: colors.popup().neutralFg!,
		button: colors.plain().bg!,
		// Search matches in the picker's list.
		match: [0.92, 0.14, 95],
		// Where a press or a linked card's flash starts (web/flash.ts).
		flash: [1, 0, 0],
	}),
	// Tools: read-only tools share READ's green, tools with writes or side
	// effects Bash's purple, messages pink. Red is kept for real failures.
	// A tool without its own entry (tool + camel-case name) uses the gray
	// `tool`.
	tool: (): Style => ({ fg: [colors.fgL, 0, 0], bg: [colors.bgL, 0, 0] }),
	toolRead: (): Style => ({ fg: [colors.fgL, colors.fgC, 155], bg: [colors.bgL, colors.bgC, 155] }),
	toolReadEntry: (): Style => colors.toolRead(),
	toolGrep: (): Style => colors.toolRead(),
	toolInspect: (): Style => colors.toolRead(),
	toolGoogle: (): Style => colors.toolRead(),
	toolWait: (): Style => colors.toolRead(),
	toolHelp: (): Style => colors.toolRead(),
	toolBash: (): Style => ({ fg: [colors.fgL, colors.fgC, 320], bg: [colors.bgL, colors.bgC, 320] }),
	toolEdit: (): Style => colors.toolBash(),
	toolCommand: (): Style => colors.toolBash(),
	toolSpawn: (): Style => colors.toolBash(),
	toolStop: (): Style => colors.toolBash(),
	toolNotify: (): Style => colors.toolBash(),
	// Inter-tab messages, both directions, in the message pink.
	toolSend: (): Style => colors.message(),
	// A plugin tool's own hue (Tool.card.hue, task m3a) at the levels every
	// tool shares, so it is as readable as the built-in ones. The web has
	// a class per 5° (.tool-hue-150).
	cardHue: (_base, hue: number): Style => ({ fg: [colors.fgL, colors.fgC, hue], bg: [colors.bgL, colors.bgC, hue] }),
	// The Hal home in the status row: Hal amber.
	halHome: (): Style => ({ fg: colors.assistant().fg! }),
}

// A theme is a plugin (tasks d3, 4c1): /theme selects it in plugins/theme.ts.
export default (plugin: Plugin) => {
	for (let [key, v] of Object.entries(look)) {
		if (typeof v === 'function') plugin.around(colors, key as never, v as never)
		else plugin.set(colors, key as never, v as never)
	}
	// Repaint in these colors now, and in the remaining ones once removed.
	render.request('theme applied')
	return () => render.request('theme removed')
}
