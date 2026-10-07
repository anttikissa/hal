// Sessions in one directory hear about recent activity (tasks 0f, c4x).
// Bash calls report the paths they declare in modifies when they start
// (file-changes.ts, task 8w); before each model request, a session hears
// which project files another open session in its cwd declared, each path
// once per window (history.messages). A path not declared again within the
// window is free. When a turn ends with a final answer, not a question,
// readers told its paths hear they are free. Paths outside the project
// (/tmp, absolute) and Git internals are left out. Activity only: files
// have no owners. In memory only: after a restart the first notes repeat.
import { clock } from './clock.ts'
import { sessions } from './sessions.ts'

const maxPaths = 5

// A path worth telling a neighbor: relative, in the project, not Git's own.
const local = (p: string) => !p.startsWith('/') && !p.startsWith('~') && !/^(\.\/)?\.git(\/|$)/.test(p)

const list = (paths: string[]) => [...paths.slice(0, maxPaths), ...paths.length > maxPaths ? [`${paths.length - maxPaths} more`] : []].join(', ')

function label(id: string): string {
	let name = sessions.state.open.get(id)?.name
	return `${id}${name ? ` (${name})` : ''}`
}

function start(sessionId: string, cwd: string, paths: string[]): void {
	let { seen, freed } = neighbors.state, entry = seen.get(sessionId)
	if (!entry || entry.cwd !== cwd) seen.set(sessionId, entry = { cwd, paths: new Map() })
	for (let p of paths.filter(local)) { entry.paths.set(p, clock.now()); freed.get(sessionId)?.paths.delete(p) }
}

// The session's turn ended with a final answer: its paths are free.
function finished(sessionId: string): void {
	let entry = neighbors.state.seen.get(sessionId)
	if (!entry) return
	neighbors.state.seen.delete(sessionId)
	neighbors.state.freed.set(sessionId, { at: clock.now(), paths: new Set(entry.paths.keys()) })
}

// Lines for `sessionId` about others: paths not told to it in the window,
// and told paths since freed. Expired paths and closed sessions go here.
function notes(sessionId: string, cwd: string): string[] {
	let now = clock.now(), { seen, sent, freed } = neighbors.state, fresh = (at?: number) => at !== undefined && now - at <= neighbors.windowMs
	let key = (id: string, p: string) => `${sessionId}|${id}|${p}`
	for (let [k, at] of sent) if (!fresh(at)) sent.delete(k)
	let lines: string[] = []
	for (let [id, entry] of freed) {
		if (!fresh(entry.at) || !sessions.state.open.has(id)) { freed.delete(id); continue }
		let told = [...entry.paths].filter((p) => sent.delete(key(id, p)))
		if (told.length) lines.push(`[${label(id)} finished its turn: ${list(told)}]`)
	}
	for (let [id, entry] of seen) {
		for (let [p, at] of entry.paths) if (!fresh(at)) entry.paths.delete(p)
		if (!entry.paths.size || !sessions.state.open.has(id)) { seen.delete(id); continue }
		if (id === sessionId || entry.cwd !== cwd) continue
		let untold = [...entry.paths.keys()].filter((p) => !sent.has(key(id, p)))
		for (let p of untold) sent.set(key(id, p), now)
		if (untold.length) lines.push(`[${label(id)} declared edits to ${list(untold)}]`)
	}
	return lines
}

export const neighbors = {
	state: {
		seen: new Map<string, { cwd: string; paths: Map<string, number> }>(),
		sent: new Map<string, number>(),
		freed: new Map<string, { at: number; paths: Set<string> }>(),
	},
	windowMs: 5 * 60_000,
	start, finished, notes,
}
