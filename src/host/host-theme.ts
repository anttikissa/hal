// A remote terminal (task tr) shows its host's colour theme (task d3),
// as the web does: this machine's own plugins/color-theme.ts is set
// aside and themes/<name>.ts from this checkout is loaded in its place.

import { existsSync } from 'fs'
import { join } from 'path'
import { plugins } from './plugins.ts'

const themesDir = () => join(import.meta.dir, '../../themes')

const state = { name: undefined as string | undefined, path: undefined as string | undefined }

// Switches to theme `name` (hal: the built-in look); says why not, if
// it can't. The host's name never reaches a path unchecked.
async function follow(name: string): Promise<string | undefined> {
	if (name === state.name) return
	if (!/^[\w-]+$/.test(name)) return `the host sent an invalid theme name: ${name}`
	let path = name === 'hal' ? undefined : join(themesDir(), `${name}.ts`)
	if (path && !existsSync(path)) return `the host's theme ${name} is not in this checkout; pull to see it`
	state.name = name
	plugins.remove(join(plugins.dir(), 'color-theme.ts'))
	if (state.path) plugins.remove(state.path)
	state.path = path
	if (path) await plugins.load(path)
}

export const hostTheme = { state, follow }
