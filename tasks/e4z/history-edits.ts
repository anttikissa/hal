// Measures what history edits cost on a copy of a real session (task
// e4z), on this machine's CPU: restart reads, repeated prompt edits and
// one /rebase drop. The source is only read. Runs on any Hal revision
// that has prompts.amend and rebasePlans.drop, so old and new compare.
// CLI: bun tasks/e4z/history-edits.ts <session dir> [edits]
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { basename } from 'path'
import { replay } from '../../src/common/replay.ts'
import { history } from '../../src/host/history.ts'
import { pages } from '../../src/host/pages.ts'
import { paths } from '../../src/host/paths.ts'
import { prompts } from '../../src/host/prompts.ts'
import { rebasePlans } from '../../src/host/rebase-plans.ts'
import { sessions } from '../../src/host/sessions.ts'
import { snapshots } from '../../src/host/snapshots.ts'
import { status } from '../../src/host/status.ts'
import { turns } from '../../src/host/turns.ts'

let [source, count = '20'] = process.argv.slice(2)
if (!source) throw new Error('usage: bun tasks/e4z/history-edits.ts <session dir> [edits]')
let id = basename(source)
let home = mkdtempSync('/tmp/hal-history-edits-')
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
paths.state.home = home
paths.init()
mkdirSync(paths.sessionDir(id), { recursive: true })
for (let f of readdirSync(source).filter((f) => /^(history\d*\.asonl|session\.ason|settings\.ason)$/.test(f)))
	cpSync(`${source}/${f}`, `${paths.sessionDir(id)}/${f}`)
// No provider: an edit's turn would start here.
turns.start = () => {}

async function time<T>(label: string, f: () => T | Promise<T>): Promise<T> {
	let read = pages.state.bytesRead,
		t = performance.now()
	let out = await f()
	let ms = performance.now() - t
	console.log(
		`${label.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms ${((pages.state.bytesRead - read) / 1e6).toFixed(1).padStart(6)} MB read`,
	)
	return out
}
function restart(): void {
	sessions.closeAll()
	pages.reset()
	history.state.cache.clear()
	status.state.states.delete(id)
	status.state.derived.delete(id)
}
let open = async () => {
	await history.open(id)
	return snapshots.build(id)
}

await time('first start (marks rebuilt)', open)
restart()
await time('restart: visible conversation', open)
restart()
let raw = await time('restart: whole history parsed', () => history.readSync(id))
await time('replay of whole history', () => replay.current(raw))

let user = (text: string) => history.submit(id, text)
let pause = () => {
	history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
	status.state.states.delete(id)
	status.state.derived.delete(id)
}
user('benchmark prompt')
pause()
let edits: number[] = []
for (let i = 0; i < Number(count); i++) {
	let t = performance.now()
	prompts.amend(id, `benchmark edit ${i}`)
	edits.push(performance.now() - t)
	pause()
}
let last = replay.current(history.readSync(id)).findLast((r) => r.type === 'user')
if (JSON.stringify(last).indexOf(`benchmark edit ${Number(count) - 1}`) < 0)
	throw new Error('the last edit is not the latest prompt')
edits.sort((a, b) => a - b)
console.log(
	`${`${count} prompt edits`.padEnd(34)} median ${edits[edits.length >> 1]!.toFixed(0)} ms, max ${edits.at(-1)!.toFixed(0)} ms`,
)
restart()
await time('restart after edits', open)

let target = replay.current(history.readSync(id)).find((r) => r.type === 'notice')!
await time('/rebase drop of one record', () => rebasePlans.drop(id, [target.n!]))
restart()
await time('restart after rebase', open)
console.log(`rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`)
