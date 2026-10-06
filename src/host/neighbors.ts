// Sessions in one directory hear about recent activity (tasks 0f, c4x).
// Bash calls report the paths they declare in modifies when they start
// (file-changes.ts, task 8w); a bash result in a cwd where another open
// session declared paths lately gets one line per neighbor after the
// output. Activity, never ownership. In memory only: after a restart the
// first notes repeat.
import { clock } from './clock.ts'
import { clients } from './clients.ts'
import { sessions } from './sessions.ts'

type Entry = { cwd: string; paths: Map<string, number>; running: number }

const maxPaths = 5

function start(sessionId: string, cwd: string, paths: string[]): void {
	let entry = neighbors.state.seen.get(sessionId)
	if (!entry || entry.cwd !== cwd) neighbors.state.seen.set(sessionId, entry = { cwd, paths: new Map(), running: 0 })
	entry.running++
	for (let p of paths) entry.paths.set(p, clock.now())
}

function end(sessionId: string): void {
	let entry = neighbors.state.seen.get(sessionId)
	if (entry) entry.running = Math.max(0, entry.running - 1)
}

// Lines for `sessionId` about others; only those whose content changed
// since the last note to this session. Times show in its client's zone.
function notes(sessionId: string, cwd: string): string[] {
	let now = clock.now(), timeZone = clients.timezone(sessionId)
	let lines: string[] = []
	for (let [id, entry] of neighbors.state.seen) {
		let key = `${sessionId}|${id}`
		let fresh = [...entry.paths].filter(([, at]) => now - at <= neighbors.windowMs)
		if (id === sessionId || entry.cwd !== cwd || !sessions.state.open.has(id) || !fresh.length) { neighbors.state.sent.delete(key); continue }
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

// The tool result with the notes (if any) after its output.
function append(output: string, sessionId: string, cwd: string): string {
	let lines = neighbors.notes(sessionId, cwd)
	return lines.length ? `${output}${output.endsWith('\n') || !output ? '' : '\n'}${lines.join('\n')}` : output
}

export const neighbors = {
	state: { seen: new Map<string, Entry>(), sent: new Map<string, string>() },
	windowMs: 15 * 60_000,
	start, end, notes, append,
}
