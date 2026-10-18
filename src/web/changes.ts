/// <reference lib="dom" />
// The changes window (task ahr): the session and file the address
// opens, moving between them without a page load, its data from the
// host, and a unified diff as numbered lines.
import { router } from './router.ts'

export type Route = { id: string; path?: string }
export type Call = { block: string; href: string }
export type FileRow = { path: string; shown: string; counts: string; time: string; calls: Call[] }
export type List = { id: string; name?: string; files: FileRow[] }
export type FileDetail = FileRow & { diff: string; commit?: string; others: { id: string; name?: string }[]; steps: { block?: string; time: string; diff: string }[] }
export type Loaded<T> = { data?: T; error?: string }
export type DiffLine = { kind: 'hunk' | 'add' | 'del' | 'same' | 'note'; text: string; old?: number; new?: number }

// `pushed`: the window added the history entry it shows, so closing
// goes Back rather than adding another.
const state: { route?: Route; pushed: boolean } = { pushed: false }

function sync(): void {
	state.route = router.changes(router.href())
	if (!state.route) state.pushed = false
	changesView.changed()
}

function open(id: string, path?: string): void {
	router.write(router.changesHref(id, path), false)
	state.pushed = true
	sync()
}

// Choosing a file rewrites the address: Back leaves the window, not
// each file seen in it.
function select(path?: string): void {
	if (!state.route) return
	router.write(router.changesHref(state.route.id, path), true)
	sync()
}

function close(): void {
	let r = state.route
	if (!r) return
	if (state.pushed) return history.back()
	router.write(router.format(r.id), true)
	sync()
}

// Leaves for an address in the shown tab (a card link): Back returns.
function leave(href: string): void {
	router.write(href, false)
	state.pushed = false
	sync()
}

async function load<T>(url: string): Promise<Loaded<T>> {
	try {
		let res = await fetch(url, { cache: 'no-store' })
		if (res.ok) return { data: await res.json() }
		return { error: `${url}: ${res.status} ${res.statusText}\n${await res.text()}` }
	} catch (e: any) {
		return { error: `${url}: ${e?.message ?? e}` }
	}
}

function list(id: string): Promise<Loaded<List>> {
	return load(`/${id}/changes.json`)
}

function file(id: string, path: string): Promise<Loaded<FileDetail>> {
	return load(`/${id}/changes.json?path=${encodeURIComponent(path)}`)
}

// A `git diff` as rows: the Git header lines go; hunk lines carry their
// old and new line numbers. Text without a hunk (no net change, content
// unavailable) is notes.
function lines(diff: string): DiffLine[] {
	let rows = diff.split('\n')
	if (rows.at(-1) === '') rows.pop()
	let start = rows.findIndex((l) => l.startsWith('@@'))
	if (start < 0) return rows.map((text) => ({ kind: 'note', text }))
	let out: DiffLine[] = [], a = 0, b = 0
	for (let text of rows.slice(start)) {
		let hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text)
		if (hunk) { a = +hunk[1]!; b = +hunk[2]!; out.push({ kind: 'hunk', text }) }
		else if (text.startsWith('+')) out.push({ kind: 'add', text: text.slice(1), new: b++ })
		else if (text.startsWith('-')) out.push({ kind: 'del', text: text.slice(1), old: a++ })
		else if (text.startsWith('\\')) out.push({ kind: 'note', text })
		else out.push({ kind: 'same', text: text.slice(1), old: a++, new: b++ })
	}
	return out
}

export const changesView = { state, changed: (): void => {}, sync, open, select, close, leave, list, file, lines }
