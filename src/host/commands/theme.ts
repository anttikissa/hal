// /theme (tasks d3, 4c1): the color theme is plugins/theme.ts, a small
// portable plugin re-exporting one of the tracked themes/<name>.ts; no
// file is the built-in look, hal (src/common/colors.ts). The plugin
// loader sees the file change and swaps the theme in every process that
// watches plugins/. An older plugins/color-theme.ts symlink into themes/
// is converted to theme.ts with the same theme.

import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import type { SlashCommand } from '../commands.ts'
import { plugins } from '../plugins.ts'

const themesDir = () => join(import.meta.dir, '../../../themes')
const file = () => join(plugins.dir(), 'theme.ts')
const oldLink = () => join(plugins.dir(), 'color-theme.ts')
const header = '// The color theme, chosen with /theme (task 4c1).\n'
const selector = /^(?:\/\/ The color theme, chosen with \/theme \(task 4c1\)\.\n)?export const portable = true\nexport \{ default \} from '[^'\n]*themes\/([\w.-]+)\.ts'\n$/

function names(): string[] {
	return [...new Set(['hal', ...readdirSync(themesDir()).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort()])]
}

// The theme a color-theme.ts symlink into themes/ selects; undefined for
// no link, a file or a link elsewhere (an ordinary plugin, left alone).
function linked(): string | undefined {
	try {
		if (!lstatSync(oldLink()).isSymbolicLink()) return undefined
		let target = resolve(realpathSync(plugins.dir()), readlinkSync(oldLink()))
		return dirname(target) === realpathSync(themesDir()) && target.endsWith('.ts') ? basename(target, '.ts') : undefined
	} catch {
		return undefined
	}
}

// The selected theme's name, or `own`: why /theme must not touch theme.ts.
function active(): { name: string; own?: undefined } | { name?: undefined; own: string } {
	let path = file()
	try {
		if (lstatSync(path).isSymbolicLink()) return { own: `${path} is a symlink /theme did not write` }
	} catch {
		return { name: linked() ?? 'hal' }
	}
	let name = readFileSync(path, 'utf8').match(selector)?.[1]
	return name ? { name } : { own: `${path} is your own file, not a theme selector` }
}

// Selects a theme by name, writing theme.ts in one rename so the loader
// never sees none; hal removes it. Returns why it refused, if it did.
function select(name: string): string | undefined {
	let now = active()
	if (now.own) return `${now.own}; /theme will not replace it. Move it away to use /theme.`
	if (name === 'hal') rmSync(file(), { force: true })
	else {
		mkdirSync(plugins.dir(), { recursive: true })
		// Relative between real paths: '../themes' in a checkout home.
		let from = relative(realpathSync(plugins.dir()), realpathSync(themesDir()))
		let tmp = `${file()}.tmp`
		writeFileSync(tmp, `${header}export const portable = true\nexport { default } from '${from}/${name}.ts'\n`)
		renameSync(tmp, file())
	}
	// Removes the link only, never its target.
	if (linked() !== undefined) rmSync(oldLink())
	return undefined
}

// Converts a recognized color-theme.ts link to theme.ts with the same
// theme; a theme.ts selector already there wins, as it did when loaded.
// A custom theme.ts keeps both as they are.
function migrate(): void {
	let now = active()
	if (linked() !== undefined && now.name !== undefined) select(now.name)
}

export const theme = { names, active, select, migrate, file }

export const command: SlashCommand = {
	help: () => '/theme asks which color theme to use, the active one chosen; /theme <name> switches to it (hal is the built-in look). Web pages show it on their next load.',
	complete: (args) => names().filter((n) => n.startsWith(args)),
	run(args, answers) {
		let now = active()
		let all = names()
		// With no name, a question to pick from, the active one chosen.
		if (!args && !answers) {
			let text = now.own ? `${now.own}; /theme will not replace it.`
				: all.includes(now.name ?? '') ? 'Pick the color theme.'
				: `${file()} selects ${now.name}, which is not in ${themesDir()}. Pick the color theme.`
			return { ask: { text, fields: [{ type: 'choice', name: 'theme', options: all, initial: Math.max(0, all.indexOf(now.name ?? '')) }] } }
		}
		args ||= answers?.theme ?? ''
		if (!all.includes(args)) return { error: `unknown theme ${args}: choose ${all.join(', ')}` }
		let refused = select(args)
		if (refused) return { error: refused }
		return { say: `theme ${args}; reload web pages to see it` }
	},
}
