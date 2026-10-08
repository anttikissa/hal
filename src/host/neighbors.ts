// Sessions in one directory hear what others edit (tasks 0f, c4x, khv).
// A tool call's modifies paths (file-changes.ts, task 8w) are declared
// while it runs, background jobs included, and for lingerMs after it ends.
// Before each model request (history.messages) a reader hears which
// declared files changed within recentMs (Unix mtime; by anyone), and once
// when the declaration ends, however long it was idle. A declared file
// nobody changed recently, or activity that ended unseen, is never told.
// Paths outside the project (/tmp, absolute) and Git internals are left
// out. Activity only: files have no owners. In memory only: after a
// restart the first notes repeat.
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
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

const glob = (p: string) => /[*?[\]{}]/.test(p)

// Declared files in `cwd` whose mtime is within recentMs of now.
function recent(cwd: string, patterns: string[], now: number): string[] {
	let found = new Set<string>()
	for (let p of patterns) for (let name of glob(p) ? new Bun.Glob(p).scanSync({ cwd, dot: true, onlyFiles: true }) : [p]) {
		let mtime = statSync(resolve(cwd, name), { throwIfNoEntry: false })?.mtimeMs
		if (mtime !== undefined && now - mtime < neighbors.recentMs) found.add(name)
	}
	return [...found]
}

// Lines for a reader told `was` about one neighbor that now declares
// `patterns`, of which `changed` were modified recently.
function change(was: string[], patterns: string[], changed: string[]): { lines: string[]; told: string[] } {
	let declared = (p: string) => patterns.some((q) => q === p || (glob(q) && new Bun.Glob(q).match(p)))
	let kept = was.filter(declared), removed = was.filter((p) => !declared(p)), added = changed.filter((p) => !was.includes(p))
	let lines: string[] = []
	if (removed.length && !kept.length && !added.length) lines.push('is no longer editing files')
	else if (removed.length) {
		let stopped = `is no longer editing ${list(removed)}`, only = `is still editing only ${list(kept)}`
		lines.push(kept.length && only.length < stopped.length ? only : stopped)
	}
	if (added.length) lines.push(`modified ${list(added)} <1min ago`)
	return { lines, told: [...kept, ...added] }
}

// Lines for `reader` about other sessions in `cwd`: declared files changed
// recently that it was not told, and told files no longer declared.
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
		let patterns = current.get(id) ?? [], result = change(mine.get(id) ?? [], patterns, recent(cwd, patterns, now))
		for (let text of result.lines) lines.push(`[${label(id)} ${text}]`)
		if (result.told.length) mine.set(id, result.told); else mine.delete(id)
	}
	if (mine.size) told.set(reader, mine); else told.delete(reader)
	return lines
}

export const neighbors = {
	state: {
		active: new Set<Declaration>(),
		// reader -> neighbor -> declared files it was told changed
		told: new Map<string, Map<string, string[]>>(),
	},
	lingerMs: 60_000,
	recentMs: 60_000,
	start, end, notes,
}
