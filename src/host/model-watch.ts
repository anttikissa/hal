// Tells the user when his providers gain or lose models on models.dev,
// without a schedule job: twice a day at a time each install picks at
// random, so a million Hals do not hit models.dev at once (task jst).

import { readFileSync, renameSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { settings } from '../common/settings.ts'
import { clock } from './clock.ts'
import { diag } from './diag.ts'
import { modelsDev } from './models-dev.ts'
import { paths } from './paths.ts'
import { provider } from './provider.ts'
import { warnings } from './warnings.ts'

type Saved = { offsetMs: number; models: Record<string, string[]> }

function file(): string {
	return `${paths.stateDir()}/model-watch.ason`
}

// The saved state; the first read picks this install's check time.
function load(): Saved {
	try {
		return ason.parse(readFileSync(modelWatch.file(), 'utf8')) as Saved
	} catch (e: any) {
		if (e?.code !== 'ENOENT') throw e
		let saved = { offsetMs: Math.floor(Math.random() * modelWatch.periodMs), models: {} }
		modelWatch.save(saved)
		return saved
	}
}

function save(saved: Saved): void {
	writeFileSync(`${modelWatch.file()}.tmp`, ason.stringify(saved))
	renameSync(`${modelWatch.file()}.tmp`, modelWatch.file())
}

// Compares the cached catalog with the last check and reports changes.
// A provider seen for the first time is only saved.
function check(): void {
	if (!Object.keys(modelsDev.catalog()).length) return
	let saved = modelWatch.load()
	let added: string[] = []
	let removed: string[] = []
	let models: Record<string, string[]> = {}
	for (let [name, p] of Object.entries(provider.state.providers)) {
		if (!(p.available?.() ?? true)) continue
		let now = modelsDev.ids(name).sort()
		models[name] = now
		let old = saved.models[name]
		if (!old) continue
		added.push(...now.filter((id) => !old.includes(id)).map((id) => `${name}/${id}`))
		removed.push(...old.filter((id) => !now.includes(id)).map((id) => `${name}/${id}`))
	}
	modelWatch.save({ offsetMs: saved.offsetMs, models })
	let parts = [added.length && `new ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`]
	let text = parts.filter(Boolean).join('; ')
	if (text) warnings.tell({ type: 'warning', text: `models.dev: ${text}` })
}

// The first check time after `now`: offsetMs past each 12-hour mark.
function next(now: number): number {
	let { offsetMs } = modelWatch.load()
	let p = modelWatch.periodMs
	return now - ((((now - offsetMs) % p) + p) % p) + p
}

// Runs for the host's life. A Hal that was off at a check time checks at
// start (main.refreshModels), so no check is lost.
async function run(): Promise<void> {
	for (;;) {
		let at = modelWatch.next(clock.now())
		while (clock.now() < at) await clock.until(at)
		if (!settings.modelWatch()) continue
		try {
			await modelsDev.refresh([], true)
			modelWatch.check()
		} catch (e: any) {
			diag.log(`model watch: ${e?.message ?? e}`)
		}
	}
}

export const modelWatch = { periodMs: 12 * 3600_000, file, load, save, check, next, run }
