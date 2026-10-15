// Plugin failures go to the last declared editor for repair, or to the
// shared notice area and history without changing unrelated sessions.
import type { NoticeEvent } from '../common/notices.ts'
import { basename } from 'path'
import { diag } from './diag.ts'
import { fileEditors } from './file-editors.ts'
import { host } from './host.ts'
import { noticeHistory } from './notice-history.ts'
import { pluginSync } from './plugin-sync.ts'
import { paths } from './paths.ts'
import { plugins } from './plugins.ts'
import { prompts } from './prompts.ts'

// The session and call that last declared and changed `path`.
function lastEditor(path: string): Promise<{ id: string; call?: number; ts: string } | undefined> {
	return fileEditors.last(path)
}

// To every client of this host; a remote terminal (task zh7), whose
// process loads its own home's plugins, shows them itself instead.
function deliver(event: NoticeEvent | { type: 'warning'; text: string }): void {
	for (let client of host.state.clients) client.deliver(event)
}

function everyone(text: string): void {
	let notice: NoticeEvent = { type: 'notice', session: '', name: 'Plugins', kind: 'failed', line: text, key: 'plugin:failure' }
	noticeHistory.record({ session: '', name: notice.name, kind: notice.kind, line: text })
	pluginReports.deliver(notice)
}

// `path`: the plugin file, when the failure disabled it.
async function report(text: string, path?: string): Promise<void> {
	process.stderr.write(`${text}\n`)
	let editor = path === undefined ? undefined : await pluginReports.lastEditor(path)
	if (!editor) return everyone(text)
	let by = editor.call === undefined ? 'A bash call' : `Your bash call t${editor.call}`
	let message = `${by} declared and changed ${path} at ${editor.ts}, before this failure; it was the last declared edit.\n${text}`
	let deliver = () => {
		let refused = prompts.submit(editor.id, message, undefined, 'steer', { from: editor.id, label: 'plugin loader' })
		if (refused) { diag.log(`plugin report to ${editor.id}: ${refused}`); everyone(text) }
	}
	let ready = host.ready(editor.id)
	if (!ready) return deliver()
	ready.then(deliver, (e) => { diag.log(`plugin report to ${editor.id}: ${e?.message ?? e}`); everyone(text) })
}

// Names where the next change to plugin `path` came from, such as a
// sync replacement, so its one notice says so; `side`: which end of a
// remote terminal's link the file is on (task zh7).
function via(path: string, source: string, side?: 'client' | 'server'): void {
	pluginReports.state.sources.set(path, side ? { source, side } : { source })
}

// A plugin lifecycle change after the initial scan (task b66): one
// notice per file to every client, kept in the notice history. Startup
// and shutdown (no watcher) stay quiet; failures go through report().
function changed(path: string, what: string): void {
	if (!plugins.state.watcher) return
	pluginSync.changed(path)
	let from = pluginReports.state.sources.get(path)
	pluginReports.state.sources.delete(path)
	if (from && what === 'reloaded') what = 'replaced'
	let name = basename(path), line = `${paths.display(path)}${from?.side ? ` on ${from.side}` : ''}${from ? ` from ${from.source}` : ''}`
	noticeHistory.record({ session: '', name, kind: 'update', line, what })
	let notice: NoticeEvent = { type: 'notice', session: '', name, kind: 'update', what, line, key: `plugin:${path}` }
	pluginReports.deliver(notice)
}

export const pluginReports = { state: { sources: new Map<string, { source: string; side?: 'client' | 'server' }>() }, lastEditor, deliver, everyone, report, via, changed }
