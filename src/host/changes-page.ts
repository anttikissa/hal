// The changes window's data (task ahr): authenticated read-only JSON;
// ?path= selects only a recorded file, never an arbitrary host file.
import { changes, type ChangedFile } from './changes.ts'
import { clients } from './clients.ts'
import { pages } from './pages.ts'
import { sessions } from './sessions.ts'

const data = /^\/(\d+-[a-z]{3})\/changes\.json$/
const moved = /^\/changes\/(\d+-[a-z]{3})$/

function owns(path: string): boolean { return data.test(path) }
// /<id>/changes is the app's own address; /changes/<id> is the old one.
function isApp(path: string): boolean { return /^\/\d+-[a-z]{3}\/changes$/.test(path) }
function redirect(url: URL): Response | undefined {
	let id = moved.exec(url.pathname)?.[1]
	if (id) return new Response(null, { status: 301, headers: { location: `/${id}/changes${url.search}` } })
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}

async function row(id: string, file: ChangedFile, cwd: string, timeZone?: string) {
	let diff = await changes.diff(id, file.before, file.after)
	return { path: file.path, shown: changes.shown(file, cwd), counts: changes.counts(diff), time: changes.time(file.ts, timeZone), calls: changes.calls(id, file), diff }
}

async function serve(url: URL): Promise<Response> {
	let id = data.exec(url.pathname)![1]!
	let all = sessions.list()
	let session = all.find((s) => s.id === id)
	if (!session) return json({ error: 'not found' }, 404)
	let selected = url.searchParams.get('path')
	let cwd = sessions.open(id).cwd, timeZone = clients.timezone(id)
	if (selected === null) {
		await pages.slices(pages.catchUp(id))
		let files = []
		for (let file of changes.list(id)) {
			let { diff: _, ...rest } = await row(id, file, cwd, timeZone)
			files.push(rest)
		}
		return json({ id, name: session.meta?.name, files })
	}
	// Catch every session's marks up in slices first: after an upgrade that
	// rebuilds marks, a synchronous catch-up of the whole home would stall.
	for (let s of all) if (!s.error) await pages.slices(pages.catchUp(s.id))
	let file = changes.list(id).find((f) => f.path === selected)
	if (!file) return json({ error: 'not found' }, 404)
	let others = all.filter((s) => s.id !== id).flatMap((s) => {
		if (s.error) throw new Error(s.error)
		return changes.list(s.id).some((f) => f.path === file.path) ? [{ id: s.id, name: s.meta?.name }] : []
	})
	let steps = []
	for (let step of file.steps) steps.push({ block: step.call === undefined ? undefined : `t${step.call}`, time: changes.time(step.ts, timeZone), diff: await changes.diff(id, step.change.before, step.change.after) })
	return json({ ...(await row(id, file, cwd, timeZone)), commit: await changes.committed(id, file), others, steps })
}

export const changesPage = { owns, isApp, redirect, serve }
