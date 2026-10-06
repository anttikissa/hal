// Example plugin (tasks an, 90v). Its hooks are commented out: it loads and
// registers nothing.
// Every plugins/*.ts in the Hal home is a plugin, loaded at startup after
// local.ts and reloaded whenever it changes (edit, save, done). Copy this
// file under another name and uncomment what you need.
//
// A plugin exports a registration function, an ordinary synchronous
// function: its body sets up and registers hooks, then returns its
// cleanup (or nothing), like a React useEffect. Each hook takes effect
// the moment it is registered, so code after it (a redraw) already sees
// it. Registration ends when the body returns. Importing the file must
// do nothing else: top-level code runs again on every reload and cannot
// be undone. When the file changes, is deleted or expires, its hooks are
// removed first, then its cleanup runs, then a new version's body.
//
// - plugin.before(obj, 'key', (...args) => {}) observes the arguments.
// - plugin.after(obj, 'key', (result, args) => {}) observes the result as
//   returned (a Promise for async functions; it is not awaited).
// - plugin.set(obj, 'key', value) overrides a plain value (a setting such
//   as models.ttlMs); the last file in filename order wins.
// - plugin.around(obj, 'key', (fn, ...args) => result) replaces the call;
//   call fn(...args) for the original (or the next around). Only around
//   changes arguments or results. It keeps the target's return type: a
//   sync function needs a sync replacement.
//
// A file that fails to import or throws in its body is like a config
// file that does not parse: Hal reports the error, runs without it and
// renames it to <name>.ts.broken. Fix it and rename it back to enable it.
//
// Hooks run in filename order, then registration order; the first
// around is outermost. A hook is not a security boundary.
//
// Temporary plugins (agents): name the file after the session, such as
// 158-lil-trace-render.ts, and set `expires` (a UTC ISO time). Once it
// passes the hooks are removed; the file stays.

import type { Plugin } from '../src/host/plugins.ts'
// import { auth } from '../src/host/auth.ts'
// import { models } from '../src/host/models.ts'
// import { tools } from '../src/host/tools.ts'
// import { diag } from '../src/host/diag.ts'
// import { colors } from '../src/common/colors.ts'
// import { terminal } from '../src/client/terminal.ts'
//
// export const expires = '2026-12-31T23:59:00Z'
//
// oxlint-disable-next-line no-unused-vars -- used once uncommented
export default (plugin: Plugin) => {
// 	// A setting: set a plain value, or around one read from config.
// 	plugin.set(models, 'ttlMs', 600_000)
// 	plugin.around(models, 'defaultModel', () => 'anthropic/claude-opus-5-5')
//
// 	// Observing: log every account choice.
// 	plugin.before(auth, 'pickAccount', (kind, list) => diag.log(`pick ${kind}: ${list.map((a) => a.name).join(', ')}`))
//
// 	// A harmless extra tool, added to the registry's result.
// 	plugin.after(tools, 'all', (found) => {
// 		found.set('today', {
// 			name: 'today',
// 			description: "Today's date.",
// 			parameters: { type: 'object', properties: {} },
// 			readOnly: true,
// 			run: async () => new Date().toDateString(),
// 		})
// 	})
//
// 	// A theme: colors are OKLCH [lightness, chroma, hue]. set replaces a
// 	// shared value, around a style. Nothing repaints for you: redraw now
// 	// with the new colors, and in cleanup once they are gone.
// 	plugin.set(colors, 'fgL', 0.85)
// 	plugin.around(colors, 'user', (fn) => ({ ...fn(), bg: [0.3, 0.06, 150] }))
// 	plugin.set(colors, 'screen', [0.2, 0.01, 150])
// 	terminal.redraw()
//
// 	// A sync target cannot wait for async work: fetch in the background
// 	// (start it here, never await it) and let the sync hook read the
// 	// cached value, which is undefined until the first fetch lands.
// 	let preferred: string | undefined
// 	let refresh = async () => (preferred = await fetchPreferred())
// 	void refresh()
// 	let timer = setInterval(refresh, 60_000)
// 	plugin.around(auth, 'pickAccount', (fn, kind, list, who) => {
// 		let out = fn(kind, list, who)
// 		let i = out.findIndex((a) => a.name === preferred)
// 		return kind === 'openai' && i > 0 ? [out[i]!, ...out.filter((_, j) => j !== i)] : out
// 	})
//
// 	return () => {
// 		clearInterval(timer)
// 		terminal.redraw()
// 	}
}

// async function fetchPreferred(): Promise<string> {
// 	return (await Bun.file('/tmp/preferred-account').text()).trim()
// }
