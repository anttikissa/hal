// /theme (task d3): the colour theme is plugins/color-theme.ts, a
// symlink to one of the tracked themes/<name>.ts; no link is the
// built-in look, hal (src/common/colors.ts). The plugin loader sees the link
// change and swaps the theme in every process that watches plugins/.

import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'fs'
import { basename, join, relative } from 'path'
import type { SlashCommand } from '../commands.ts'
import { plugins } from '../plugins.ts'

const themesDir = () => join(import.meta.dir, '../../../themes')
const link = () => join(plugins.dir(), 'color-theme.ts')

function names(): string[] {
	return ['hal', ...readdirSync(themesDir()).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort()]
}

// The active theme's name; undefined when color-theme.ts is a file of
// the user's own, which /theme must not overwrite.
function active(): string | undefined {
	try {
		if (!lstatSync(link()).isSymbolicLink()) return undefined
	} catch {
		return 'hal'
	}
	return basename(readlinkSync(link()), '.ts')
}

export const command: SlashCommand = {
	help: () => '/theme asks which colour theme to use, the active one chosen; /theme <name> switches to it (hal is the built-in look). Web pages show it on their next load.',
	complete: (args) => names().filter((n) => n.startsWith(args)),
	run(args, answers) {
		let now = active()
		let all = names()
		// With no name, a question to pick from, the active one chosen.
		if (!args && !answers) {
			let text = now ? 'Pick the colour theme.' : `${link()} is your own file, not a theme link; /theme will not replace it.`
			return { ask: { text, fields: [{ type: 'choice', name: 'theme', options: all, initial: Math.max(0, all.indexOf(now ?? '')) }] } }
		}
		args ||= answers?.theme ?? ''
		if (!all.includes(args)) return { error: `unknown theme ${args}: choose ${all.join(', ')}` }
		if (now === undefined) return { error: `${link()} is your own file; move it away to use /theme` }
		if (args === 'hal') rmSync(link(), { force: true })
		else {
			// Replace the link in one rename, so the loader never sees none.
			let tmp = `${link()}.tmp`
			mkdirSync(plugins.dir(), { recursive: true })
			rmSync(tmp, { force: true })
			// Relative, so a moved checkout keeps it; real paths, since a link
			// resolves from where the directory really is.
			symlinkSync(relative(realpathSync(plugins.dir()), realpathSync(join(themesDir(), `${args}.ts`))), tmp)
			renameSync(tmp, link())
		}
		return { say: `theme ${args}; reload web pages to see it` }
	},
}
