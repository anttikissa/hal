// /plugins: this host's plugin files, their hooks, expiry, content hash
// and last load error (task an). /plugins disable|enable <file> adds or
// removes plugin.disable() as the registration body's first line (task
// hvk), so turning a plugin off needs no editor and no model.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SlashCommand } from '../commands.ts'
import { plugins } from '../plugins.ts'

// `export default (plugin: Plugin) => {` or `export default function (plugin) {`;
// group 1 or 2 is the parameter name.
const HEAD = /export\s+default\s+(?:async\s+)?(?:function\s*\w*\s*\(\s*(\w+)[^)]*\)[^{]*|\(?\s*(\w+)[^)=]*\)?\s*(?::[^=]*)?=>\s*)\{/
// A whole line that only calls disable(), as /plugins disable writes it.
const line = (p: string) => new RegExp(`^[ \\t]*${p}\\.disable\\(\\)[ \\t;]*(?://.*)?\\r?\\n`, 'm')

const files = () => readdirSync(plugins.dir()).filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts')).sort()

async function toggle(verb: 'disable' | 'enable', arg: string) {
	let name = arg.endsWith('.ts') ? arg : `${arg}.ts`
	let path = join(plugins.dir(), name)
	if (!arg || name.includes('/') || !existsSync(path)) return { error: `/plugins ${verb}: no plugin file ${arg ? path : 'given'}; files: ${files().join(', ') || 'none'}` }
	let src = readFileSync(path, 'utf8')
	let m = HEAD.exec(src)
	if (!m) return { error: `/plugins ${verb}: ${path} has no inline export default (plugin) => { ... } to edit; add or remove plugin.disable() by hand` }
	let p = (m[1] ?? m[2])!
	let has = line(p).test(src)
	if (verb === 'disable') {
		if (has) return { say: `${name} already calls ${p}.disable()` }
		let at = m.index + m[0].length
		src = `${src.slice(0, at)}\n\t${p}.disable() // /plugins enable removes this line${src.slice(at)}`
	} else {
		if (!has) return plugins.state.files.get(path)?.disabled ? { error: `/plugins enable: ${path} calls ${p}.disable() in a way this command does not edit; change it by hand` } : { say: `${name} is not disabled` }
		while (line(p).test(src)) src = src.replace(line(p), '')
	}
	writeFileSync(path, src)
	await plugins.sync(plugins.dir(), name)
	// The watcher's load of the same write may supersede ours; wait for
	// whichever load reaches this content.
	let hash = plugins.hashOf(path)
	for (let t = 0; t < 80 && plugins.state.files.get(path)?.hash !== hash; t++) await Bun.sleep(25)
	let e = plugins.state.files.get(path)
	if (e?.hash !== hash) return { error: `/plugins ${verb}: edited ${path}, but it has not reloaded within 2 s; check /plugins` }
	return e?.error ? { error: `${path}: ${e.error}` } : { say: `${name}: ${e?.disabled ? 'disabled' : e?.expired ? 'expired' : 'loaded'}` }
}

export const command: SlashCommand = {
	help: () => `/plugins lists the plugin files in ${plugins.dir()}: content hash, expiry, each hook as module.key kind, and the last load error. /plugins disable <file> adds plugin.disable() as the first line of the file's registration body, switching it off without deleting it; /plugins enable <file> removes that line.`,
	complete: (args) => {
		let m = /^(disable|enable) (.*)$/.exec(args)
		if (m) return files().map((f) => `${m[1]} ${f}`).filter((s) => s.startsWith(args))
		return ['disable ', 'enable '].filter((s) => s.startsWith(args))
	},
	run: async (args) => {
		let [verb, ...rest] = args.split(/\s+/)
		if (verb === 'disable' || verb === 'enable') return toggle(verb, rest.join(' '))
		if (args) return { error: `/plugins: unknown argument '${args}'; use disable <file> or enable <file>` }
		return { say: plugins.describe() }
	},
}
