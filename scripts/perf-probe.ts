// Perf probe: simulates keypresses during startup to find where
// the event loop blocks. Writes timing to /tmp/hal-perf.log.
//
// Usage: timeout 5 bun scripts/perf-probe.ts

import { appendFileSync, writeFileSync } from 'fs'

const LOG = '/tmp/hal-perf.log'
const t0 = performance.now()
const log = (msg: string) => appendFileSync(LOG, `${(performance.now() - t0).toFixed(1)}ms  ${msg}\n`)

writeFileSync(LOG, '')
log('probe start')

// Import the app modules
const { perf } = await import('../src/client/perf.ts')
const { client } = await import('../src/client/app.ts')
const { blockData } = await import('../src/client/block-data.ts')
await import('../src/config.ts')
const { sessions } = await import('../src/server/sessions.ts')

log('imports done')

// Simulate what startClient does, with probes

// 1. Load sessions through the same startup path the client uses now
const loaded = sessions.loadAllSessionMetas().map((meta) => ({
	meta,
	history: sessions.loadAllHistory(meta.id),
}))
log(`loaded ${loaded.length} sessions`)

// 2. Find active tab
const lastTab = '09-bx8'

// 3. Convert active tab
const active = loaded.find((s) => s.meta.id === lastTab)!
const activeBlocks = blockData.historyToBlocks(active.history, active.meta.id)
log(`active tab converted: ${activeBlocks.length} blocks`)

// 4. Simulate keypress responsiveness: setInterval that logs timestamps.
// Any gap > 20ms between ticks means the event loop was blocked.
let tickCount = 0
let lastTick = performance.now()
const ticker = setInterval(() => {
	const now = performance.now()
	const gap = now - lastTick
	tickCount++
	if (gap > 20) {
		log(`BLOCKED ${gap.toFixed(0)}ms (tick ${tickCount})`)
	}
	lastTick = now
}, 10)

// 5. Load active tab blobs (the suspected blocker)
log('loading active tab blobs...')
const n1 = await blockData.loadBlobs(activeBlocks)
log(`active tab blobs done: ${n1} blobs`)

// 6. Convert + load remaining tabs
log('loading remaining tabs...')
for (const s of loaded) {
	if (s.meta.id === lastTab) continue
	const b = blockData.historyToBlocks(s.history, s.meta.id)
	log(`  tab ${s.meta.id}: ${b.length} blocks, loading blobs...`)
	const n = await blockData.loadBlobs(b)
	log(`  tab ${s.meta.id}: ${n} blobs done`)
}
log('all tabs done')

clearInterval(ticker)
log(`total ticks: ${tickCount}`)

// Print log
console.log(await Bun.file(LOG).text())
process.exit(0)
