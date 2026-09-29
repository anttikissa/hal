// Sessions in one directory hear who edits what (task 0f). Bash calls
// record the paths they declare and change (file-changes.ts, task 8w);
// a bash result in a cwd where another open session did so lately gets
// one line per neighbour after the output. Observations, not proof of
// authorship. In memory only: after a restart the first notes repeat.
import { clock } from './clock.ts'
import { sessions } from './sessions.ts'

type Entry = { cwd: string; paths: Map<string, number> }

const maxPaths = 5

function record(sessionId: string, cwd: string, paths: string[]): void {
	let entry = neighbours.state.seen.get(sessionId)
	if (!entry || entry.cwd !== cwd) neighbours.state.seen.set(sessionId, entry = { cwd, paths: new Map() })
	for (let p of paths) entry.paths.set(p, clock.now())
}

// Lines for `ctx`'s session about others; only those whose content
// (not the age) changed since the last note to this session.
function notes(sessionId: string, cwd: string): string[] {
	let now = clock.now(), mine = neighbours.state.seen.get(sessionId)
	let own = new Set(mine?.cwd === cwd ? [...mine.paths.keys()] : [])
	let lines: string[] = []
	for (let [id, entry] of neighbours.state.seen) {
		let key = `${sessionId}|${id}`
		let fresh = [...entry.paths].filter(([, at]) => now - at <= neighbours.windowMs())
		if (id === sessionId || entry.cwd !== cwd || !sessions.state.open.has(id) || !fresh.length) { neighbours.state.sent.delete(key); continue }
		// Shared paths first, then newest.
		fresh.sort((a, b) => Number(own.has(b[0])) - Number(own.has(a[0])) || b[1] - a[1])
		let shown = fresh.slice(0, maxPaths).map(([p]) => own.has(p) ? `${p} (also yours)` : p)
		if (fresh.length > maxPaths) shown.push(`${fresh.length - maxPaths} more`)
		let name = sessions.state.open.get(id)?.name
		let who = `${id}${name ? ` (${name})` : ''} is editing ${shown.join(', ')}`
		if (neighbours.state.sent.get(key) === who) continue
		neighbours.state.sent.set(key, who)
		let min = Math.floor((now - Math.max(...fresh.map(([, at]) => at))) / 60_000)
		lines.push(`[${who}; ${min < 1 ? 'just now' : `${min} min ago`}]`)
	}
	return lines
}

// The tool result with the notes (if any) after its output.
function append(output: string, sessionId: string, cwd: string): string {
	let lines = neighbours.notes(sessionId, cwd)
	return lines.length ? `${output}${output.endsWith('\n') || !output ? '' : '\n'}${lines.join('\n')}` : output
}

export const neighbours = {
	state: { seen: new Map<string, Entry>(), sent: new Map<string, string>() },
	windowMs: () => 15 * 60_000,
	record, notes, append,
}
