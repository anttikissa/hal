// Example plugin (task an). Its hooks are commented out: it loads and
// registers nothing.
// Every plugins/*.ts in the Hal home is a plugin, loaded at startup after
// local.ts and reloaded whenever it changes (edit, save, done). Copy this
// file under another name and uncomment what you need.
//
// A plugin exports a registration function. Importing the file must do
// nothing else: its top-level code runs again on every reload and cannot
// be undone, while hooks registered through `plugin` are removed exactly
// when the file changes, is deleted or expires. A reload that fails to
// import or register keeps the last working hooks and reports the path.
//
// - plugin.before(obj, 'key', (...args) => {}) observes the arguments.
// - plugin.after(obj, 'key', (result, args) => {}) observes the result as
//   returned (a Promise for async functions; it is not awaited).
// - plugin.around(obj, 'key', (fn, ...args) => result) replaces the call;
//   call fn(...args) for the original (or the next around). Only around
//   changes arguments or results. It keeps the target's return type: a
//   sync function needs a sync replacement.
// - plugin.unload(() => {}) runs when the file's hooks are removed.
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
//
// export const expires = '2026-12-31T23:59:00Z'
//
// oxlint-disable-next-line no-unused-vars -- used once uncommented
export default async (plugin: Plugin) => {
// 	// A setting: around a config function.
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
// 	// A sync target cannot wait for async work: fetch ahead (here while
// 	// registering, which may be async, then on a timer) and let the
// 	// sync hook read the cached value.
// 	let preferred = await fetchPreferred()
// 	let timer = setInterval(async () => (preferred = await fetchPreferred()), 60_000)
// 	plugin.unload(() => clearInterval(timer))
// 	plugin.around(auth, 'pickAccount', (fn, kind, list, who) => {
// 		let out = fn(kind, list, who)
// 		let i = out.findIndex((a) => a.name === preferred)
// 		return kind === 'openai' && i > 0 ? [out[i]!, ...out.filter((_, j) => j !== i)] : out
// 	})
}

// async function fetchPreferred(): Promise<string> {
// 	return (await Bun.file('/tmp/preferred-account').text()).trim()
// }
