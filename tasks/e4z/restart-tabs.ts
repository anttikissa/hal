// Measures what a restart reads for a heavy home's open tabs (task e4z),
// on this machine's CPU: each tab's state for the tab bar, and each
// tab's visible conversation. Marks missing or stale are rebuilt in a
// first pass, so the second pass is a plain restart. Writes marks, so
// point it at a copy. CLI: bun tasks/e4z/restart-tabs.ts <hal home copy>
import { readFileSync } from 'fs'
import { ason } from '../../src/common/ason.ts'
import { history } from '../../src/host/history.ts'
import { pages } from '../../src/host/pages.ts'
import { paths } from '../../src/host/paths.ts'
import { sessions } from '../../src/host/sessions.ts'
import { snapshots } from '../../src/host/snapshots.ts'
import { status } from '../../src/host/status.ts'

let home = process.argv[2]
if (!home) throw new Error('usage: bun tasks/e4z/restart-tabs.ts <hal home copy>')
paths.state.home = home
paths.init()
let open = (ason.parse(readFileSync(`${home}/state/tabs.ason`, 'utf8')) as { open: string[] }).open

async function pass(label: string, each: (id: string) => unknown): Promise<void> {
	sessions.closeAll()
	pages.reset()
	history.state.cache.clear()
	status.state.states.clear()
	status.state.derived.clear()
	let read = pages.state.bytesRead,
		t = performance.now()
	for (let id of open) {
		await history.open(id)
		each(id)
	}
	let ms = performance.now() - t
	console.log(
		`${label.padEnd(34)} ${ms.toFixed(0).padStart(7)} ms ${((pages.state.bytesRead - read) / 1e6).toFixed(1).padStart(7)} MB read`,
	)
}

console.log(`${open.length} open tabs`)
await pass('first start: every tab state', (id) => status.stateOf(id))
await pass('restart: every tab state', (id) => status.stateOf(id))
await pass('restart: every visible conversation', (id) => snapshots.build(id))
console.log(`rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`)
