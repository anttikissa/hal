// Where a plugin failure goes (task njq). A disabled plugin is reported
// to the session whose bash call last declared and changed its file,
// so that session can fix its own work; otherwise, naming no session,
// to every open session and client. Activity, never a guessed writer.
import { realpathSync } from 'fs'
import { basename, dirname, resolve } from 'path'
import { changes } from './changes.ts'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { pages } from './pages.ts'
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
		let refused = prompts.submit(editor.id, message, undefined, false, { from: editor.id, label: 'plugin loader' })
		if (refused) { diag.log(`plugin report to ${editor.id}: ${refused}`); everyone(text) }
	}
	let ready = host.ready(editor.id)
	if (!ready) return deliver()
	ready.then(deliver, (e) => { diag.log(`plugin report to ${editor.id}: ${e?.message ?? e}`); everyone(text) })
}

export const pluginReports = { canonical, lastEditor, everyone, report }
