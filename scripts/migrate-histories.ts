// Converts a Hal home's histories for task e4z. Run by hand with Hal
// stopped (scripts/migrate-histories); nothing on the host path calls it.
// A history whose old rebases or edits readers still replay gets a
// resolved generation (rewriteHistory.migrate); history.asonl stays as
// it was. Every session's marks are rebuilt, so the next start reads no
// whole history. Prints each converted session and every difference in
// its conversation, state, inbox and rewrite dividers. A rerun skips
// what is done.
import { readdirSync } from 'fs'
import { rebaseDisplay } from '../src/common/rebase-display.ts'
import { replay, type HistoryRecord } from '../src/common/replay.ts'
import { history } from '../src/host/history.ts'
import { pages } from '../src/host/pages.ts'
import { paths } from '../src/host/paths.ts'
import { rewriteHistory } from '../src/host/rewrite-history.ts'
import { server } from '../src/host/server.ts'
import { sessions } from '../src/host/sessions.ts'
import { status } from '../src/host/status.ts'

let home = process.argv[2]
if (!home) throw new Error('usage: scripts/migrate-histories <hal home>')
paths.state.home = home
paths.init()
if (!server.tryLock()) throw new Error(`Hal is running on ${home}; stop it first.`)

// What a session shows and sends, rebase markers aside.
function seen(id: string): Record<string, unknown> {
	let raw = history.readSync(id)
	let current = replay.current(raw)
	return {
		conversation: current.filter((r) => r.type !== 'rebase'),
		state: status.stateOf(id, current),
		inbox: status.inboxOf(id, current),
		dividers: dividers(raw),
	}
}
function dividers(raw: HistoryRecord[]): string[] {
	if (!raw.some((r) => r.type === 'rebase' && r.applied))
		return rebaseDisplay.dividers(raw).map((d) => `${d.n} ${d.text}`)
	return raw.flatMap((r) => (r.type === 'rebase' && !r.quiet && r.inactive === undefined ? [`${r.n} ${r.text}`] : []))
}

let converted = 0,
	differences = 0
for (let id of readdirSync(paths.sessionsDir()).sort()) {
	let t = performance.now()
	let before = seen(id)
	let done = rewriteHistory.migrate(id)
	if (done) {
		converted++
		history.state.cache.delete(id)
		let after = seen(id)
		let changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
		differences += changed.length
		console.log(
			`${id}: resolved in ${(performance.now() - t).toFixed(0)} ms${changed.length ? `; DIFFERS: ${changed.join(', ')}` : ''}`,
		)
		for (let k of changed)
			console.log(
				`  before ${k}: ${JSON.stringify(before[k]).slice(0, 400)}\n  after  ${k}: ${JSON.stringify(after[k]).slice(0, 400)}`,
			)
	}
	pages.marks(id)
	sessions.closeAll()
	pages.reset()
	history.state.cache.clear()
}
console.log(`${converted} histories resolved; ${differences} differences.`)
