// Sessions in one directory hear who may be editing what (tasks 0f, c4x,
// khv). A tool call's modifies paths (file-changes.ts, task 8w) are active
// while it runs, background jobs included, and for lingerMs after it ends.
// Before each model request (history.messages) a reader hears another
// session's active paths; a reader that was told hears once when that set
// changes or empties, however long it was idle. Activity nobody saw while
// active is never told. Paths outside the project (/tmp, absolute) and Git
// internals are left out. Activity only: files have no owners. In memory
// only: after a restart the first notes repeat.
import { clock } from './clock.ts'
import { sessions } from './sessions.ts'

type Declaration = { sessionId: string; cwd: string; paths: string[]; ended?: number }

const maxPaths = 5

// A path worth telling a neighbor: relative, in the project, not Git's own.
const local = (p: string) => !p.startsWith('/') && !p.startsWith('~') && !/^(\.\/)?\.git(\/|$)/.test(p)

const list = (paths: string[]) => [...paths.slice(0, maxPaths), ...paths.length > maxPaths ? [`${paths.length - maxPaths} more`] : []].join(', ')

function label(id: string): string {
	let name = sessions.state.open.get(id)?.name
	return `${id}${name ? ` (${name})` : ''}`
}

// A call declared paths; end() the returned declaration when it stops.
function start(sessionId: string, cwd: string, paths: string[]): Declaration {
	let d: Declaration = { sessionId, cwd, paths: paths.filter(local) }
	if (d.paths.length) neighbors.state.active.add(d)
	return d
}

function end(d: Declaration): void {
	d.ended ??= clock.now()
}

// What changed for a reader told `was` that should now know `now`.
function change(was: string[], now: string[]): string | undefined {
	let added = now.filter((p) => !was.includes(p)), removed = was.filter((p) => !now.includes(p))
	if (!added.length && !removed.length) return undefined
	if (!now.length) return 'is no longer editing files'
	if (!was.length) return `may be editing ${list(now)}`
	if (!removed.length) return `may also be editing ${list(added)}`
	let only = `is now editing only ${list(now)}`, stopped = `is no longer editing ${list(removed)}`
	return !added.length && stopped.length < only.length ? stopped : only
}

// Lines for `reader` about other sessions in `cwd` whose active paths
// differ from what it was last told.
function notes(reader: string, cwd: string): string[] {
	let now = clock.now(), { active, told } = neighbors.state, open = sessions.state.open
	let current = new Map<string, string[]>()
	for (let d of active) {
		if ((d.ended !== undefined && now - d.ended > neighbors.lingerMs) || !open.has(d.sessionId)) { active.delete(d); continue }
		if (d.sessionId === reader || d.cwd !== cwd) continue
		let paths = current.get(d.sessionId) ?? []
		current.set(d.sessionId, [...paths, ...d.paths.filter((p) => !paths.includes(p))])
	}
	for (let id of told.keys()) if (!open.has(id)) told.delete(id)
	let mine = told.get(reader) ?? new Map<string, string[]>(), lines: string[] = []
	for (let id of new Set([...mine.keys(), ...current.keys()])) {
		let paths = current.get(id) ?? [], text = change(mine.get(id) ?? [], paths)
		if (text) lines.push(`[${label(id)} ${text}]`)
		if (paths.length) mine.set(id, paths); else mine.delete(id)
	}
	if (mine.size) told.set(reader, mine); else told.delete(reader)
	return lines
}

export const neighbors = {
	state: {
		active: new Set<Declaration>(),
		// reader -> neighbor -> active paths it was last told
		told: new Map<string, Map<string, string[]>>(),
	},
	lingerMs: 60_000,
	start, end, notes,
}
