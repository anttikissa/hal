// config.ason: the common settings (declared in src/common/settings.ts)
// as a live file in the home root. User-edited like a dotfile; edits
// apply at once. It never stops Hal: a missing file means defaults, and
// a malformed file, bad value or unknown key is a warning (host.ts shows
// it to every client) while that setting keeps its default.

import { settings } from '../common/settings.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

// Loads and watches config.ason; `onChange` hears every external edit.
// Idempotent.
function init(onChange?: () => void): void {
	if (config.state.data) return
	let data = liveFiles.liveFile<Record<string, unknown>>(paths.configFile(), {}, { keepBroken: true, onChange: () => onChange?.() })
	config.state.data = data
	settings.state.raw = data
}

// What is wrong with the file right now, one line each.
function warnings(): string[] {
	let data = config.state.data
	if (!data) return []
	let broken = liveFiles.brokenError(data)
	if (broken) return [`${paths.display(broken.message)}; using the last good settings`]
	return settings.warnings().map((w) => `config.ason: ${w}`)
}

// Apply only changed keys, preserving unknown keys and comments. Defaults
// are represented by absence. Refuse a broken file before mutating it.
function update(values: Record<string, unknown>): string[] {
	config.init()
	let data = config.state.data!
	let broken = liveFiles.brokenError(data)
	if (broken) throw broken
	let changed: string[] = []
	let current = settings.check(data).values
	for (let s of settings.table) {
		if (!(s.name in values) || Object.is(values[s.name], current[s.name])) continue
		let why = settings.problem(s.type, values[s.name])
		if (why) throw new Error(`${s.name}: ${why}`)
	}
	for (let s of settings.table) {
		if (!(s.name in values) || Object.is(values[s.name], current[s.name])) continue
		if (Object.is(values[s.name], s.default)) delete data[s.name]
		else data[s.name] = values[s.name]
		changed.push(s.name)
	}
	liveFiles.save(data)
	return changed
}
// Stops watching and forgets the file (tests).
function reset(): void {
	let data = config.state.data
	config.state.data = null
	settings.state.raw = {}
	if (data) liveFiles.close(data)
}

export const config = {
	state: { data: null as Record<string, unknown> | null },
	init,
	warnings,
	update,
	reset,
}
