// Where a plugin failure goes (task njq). A disabled plugin is reported
// to the session whose bash call last declared and changed its file,
// so that session can fix its own work; otherwise, naming no session,
// to every open session and client. Activity, never a guessed writer.
import { realpathSync } from 'fs'
import type { NoticeEvent } from '../common/notices.ts'
import { basename, dirname, resolve } from 'path'
import { changes } from './changes.ts'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { noticeHistory } from './notice-history.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { plugins } from './plugins.ts'
import { prompts } from './prompts.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'

// The file's path with its directory's symlinks resolved; the file
// itself may already be renamed away.
function canonical(path: string): string {
	try { return `${realpathSync(dirname(path))}/${basename(path)}` } catch { return resolve(path) }
}

// The session and call that last declared and changed `path`.
async function lastEditor(path: string): Promise<{ id: string; call?: number; ts: string } | undefined> {
	let target = canonical(path), best: { id: string; call?: number; ts: string } | undefined
	for (let s of sessions.list()) {
		if (s.error) continue
		await pages.slices(pages.catchUp(s.id))
		for (let file of changes.list(s.id)) {
			if (canonical(file.path) !== target) continue
			let step = file.steps.at(-1)!
			if (!best || step.ts > best.ts) best = { id: s.id, call: step.call, ts: step.ts }
		}
	}
	return best
}

function everyone(text: string): void {
	for (let id of sessions.openIds()) slash.output(id, text, true)
	for (let client of host.state.clients) client.deliver({ type: 'warning', text })
}

// `path`: the plugin file, when the failure disabled it.
async function report(text: string, path?: string): Promise<void> {
	process.stderr.write(`${text}\n`)
	let editor = path === undefined ? undefined : await pluginReports.lastEditor(path)
	if (!editor) return everyone(text)
	let by = editor.call === undefined ? 'A bash call' : `Your bash call #t${editor.call}`
	let message = `${by} declared and changed ${path} at ${editor.ts}, before this failure; it was the last declared edit.\n${text}`
	let deliver = () => {
		let refused = prompts.submit(editor.id, message, undefined, 'interrupt', { from: editor.id, label: 'plugin loader' })
		if (refused) { diag.log(`plugin report to ${editor.id}: ${refused}`); everyone(text) }
	}
	let ready = host.ready(editor.id)
	if (!ready) return deliver()
	ready.then(deliver, (e) => { diag.log(`plugin report to ${editor.id}: ${e?.message ?? e}`); everyone(text) })
}

// Names where the next change to plugin `path` came from, such as a
// sync replacement, so its one notice says so.
function via(path: string, source: string): void {
	pluginReports.state.sources.set(path, source)
}

// A plugin lifecycle change after the initial scan (task b66): one
// notice per file to every client, kept in the notice history. Startup
// and shutdown (no watcher) stay quiet; failures go through report().
function changed(path: string, what: string): void {
	if (!plugins.state.watcher) return
	let source = pluginReports.state.sources.get(path)
	pluginReports.state.sources.delete(path)
	if (source && what === 'reloaded') what = 'replaced'
	let name = basename(path), line = `${paths.display(path)}${source ? ` from ${source}` : ''}`
	noticeHistory.record({ session: '', name, kind: 'update', line, what })
	let notice: NoticeEvent = { type: 'notice', session: '', name, kind: 'update', what, line, key: `plugin:${path}` }
	for (let client of host.state.clients) client.deliver(notice)
}

export const pluginReports = { state: { sources: new Map<string, string>() }, canonical, lastEditor, everyone, report, via, changed }
