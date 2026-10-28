// Building blocks for theme plugins: themePlugin applies a look of field
// overrides on the base; palette builds a full look from seven colors.
import { colors, type Look, type Style } from '../common/colors.ts'
import type { Oklch } from '../common/oklch.ts'
import { render } from './render.ts'
import type { Plugin } from '../host/plugins.ts'

type Palette = {
	screen: Oklch
	user: [Oklch, Oklch]
	reply: Oklch
	accent: Oklch
	read: Oklch
	edit: Oklch
	bash: Oklch
}
export function palette(p: Palette): Look {
	const surface: Oklch = [0.2, p.screen[1], p.screen[2]]
	const gray: Oklch = [0.74, 0.01, p.screen[2]]
	const card = (fg: Oklch, bg = surface): Style => ({ fg, bg, code: fg, linkFg: fg, linkBg: bg })
	const text = (fg: Oklch): Style => ({ fg, bold: [0.94, 0.025, fg[2]], code: fg, linkFg: p.accent, linkBg: surface })
	return {
		screen: p.screen,
		fgL: 0.8,
		fgC: 0.1,
		bgL: 0.2,
		bgC: p.screen[1],
		user: () => card(...p.user),
		assistant: () => ({ ...text(p.reply), cursor: p.reply, cursorIdle: gray }),
		thinking: () => text(gray),
		message: () => card(p.accent),
		question: () => card(p.accent),
		info: () => card(gray),
		error: () => card(colors.red),
		warning: () => card(colors.yellow),
		exit: () => ({ fg: colors.red, neutralFg: gray }),
		log: () => text(gray),
		fork: () => card(p.accent),
		commitCard: () => card(p.edit),
		tool: () => card(gray),
		toolRead: () => card(p.read),
		toolBash: () => card(p.bash),
		status: () => ({ fg: gray, highlight: p.accent }),
		tab: (base) => ({ ...base(), activeFg: p.accent, inactiveFg: gray, pausedFg: gray, jobsFg: p.bash }),
		help: () => ({ key: p.accent, description: gray, update: colors.yellow }),
		popup: () => ({ neutralFg: gray, dangerFg: colors.red }),
		popupMatch: () => ({ fg: colors.yellow }),
		popupNote: () => ({ fg: gray }),
		popupModelCurrent: () => card(p.accent),
		page: () => ({
			canvas: p.screen,
			text: p.reply,
			accent: p.accent,
			field: surface,
			border: gray,
			button: surface,
			match: colors.yellow,
			flash: [1, 0, 0],
		}),
	}
}
export function themePlugin(look: Look) {
	return (plugin: Plugin) => {
		for (const [key, value] of Object.entries(look)) {
			if (typeof value === 'function') plugin.around(colors, key as never, value as never)
			else plugin.set(colors, key as never, value as never)
		}
		render.request('theme applied')
		return () => render.request('theme removed')
	}
}
