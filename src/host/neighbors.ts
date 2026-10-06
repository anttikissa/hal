// Recent declared activity among open same-cwd sessions, sampled before
// model requests. State is bounded by the recent window and open sessions;
// after a host restart the first facts repeat. Tasks: 0f, c4x, nvm.
import { clock } from './clock.ts'
import { clients } from './clients.ts'
import { sessions } from './sessions.ts'

type Entry = { cwd: string; paths: Map<string, number>; running: number }

const maxPaths = 5

function start(sessionId: string, cwd: string, paths: string[]): void {
	neighbors.prune()
	let entry = neighbors.state.seen.get(sessionId)
	if (!entry || entry.cwd !== cwd) neighbors.state.seen.set(sessionId, entry = { cwd, paths: new Map(), running: 0 })
	entry.running++
	for (let p of paths) entry.paths.set(p, clock.now())
}

function end(sessionId: string): void {
	let entry = neighbors.state.seen.get(sessionId)
	if (entry) entry.running = Math.max(0, entry.running - 1)
}

// Discard expired paths, closed/moved activity and its delivery fingerprints.
// Keep active counters until exit so an old background call cannot finish a newer one.
function prune(): void {
	let now = clock.now()
	for (let [id, entry] of neighbors.state.seen) {
		for (let [path, at] of entry.paths) if (now - at > neighbors.windowMs) entry.paths.delete(path)
		if ((!entry.paths.size && !entry.running) || sessions.state.open.get(id)?.cwd !== entry.cwd) neighbors.state.seen.delete(id)
	}
	for (let key of neighbors.state.sent.keys()) {
		let [viewer, id] = key.split('|')
		let entry = neighbors.state.seen.get(id!)
		if (!entry?.paths.size || sessions.state.open.get(viewer!)?.cwd !== entry.cwd) neighbors.state.sent.delete(key)
	}
}

// Lines for `sessionId` about others; only those whose content changed
// since the last note to this session. Times show in its client's zone.
function notes(sessionId: string, cwd: string): string[] {
	neighbors.prune()
	let timeZone = clients.timezone(sessionId)
	let lines: string[] = []
	for (let [id, entry] of neighbors.state.seen) {
		let key = `${sessionId}|${id}`
		let fresh = [...entry.paths]
		if (id === sessionId || entry.cwd !== cwd || !fresh.length) { neighbors.state.sent.delete(key); continue }
		fresh.sort((a, b) => b[1] - a[1])
		let shown = fresh.slice(0, maxPaths).map(([p]) => p)
		if (fresh.length > maxPaths) shown.push(`${fresh.length - maxPaths} more`)
		let name = sessions.state.open.get(id)?.name
		let time = new Date(fresh[0]![1]).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
		let line = `[${id}${name ? ` (${name})` : ''} declared edits to ${shown.join(', ')} at ${time}; call ${entry.running ? 'running' : 'finished'}]`
		if (neighbors.state.sent.get(key) === line) continue
		neighbors.state.sent.set(key, line)
		lines.push(line)
	}
	return lines
}

export const neighbors = {
	state: { seen: new Map<string, Entry>(), sent: new Map<string, string>() },
	windowMs: 15 * 60_000,
	start, end, prune, notes,
}
